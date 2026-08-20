'use strict';

const EventEmitter = require('events');
const { TrueNasClient } = require('./TrueNasClient');
const {
  get, toNumber, round, percent, formatUptime, shortVersion,
} = require('./util');

const UPDATE_CHECK_INTERVAL = 12 * 60 * 60 * 1000;
const MAX_INTERFACE_GRAPHS = 8;
const RECONNECT_BASE = 5000;
const RECONNECT_MAX = 300000;

/** Alert levels ordered from least to most severe. */
const ALERT_LEVELS = ['INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'];
const ALARM_FROM_LEVEL = 'ERROR';

/** Task states that mean the last run did not succeed. */
const FAILED_TASK_STATES = ['FAILED', 'ERROR', 'ABORTED'];

/**
 * One hub per TrueNAS system. Owns the single WebSocket connection and runs one
 * shared poll cycle, so twenty Homey devices still produce one request per tier
 * instead of twenty.
 *
 * Poll tiers:
 *   fast  — system, pools, services, apps, VMs, alerts, reporting graphs
 *   slow  — disks and disk temperatures (SMART reads can keep drives spinning)
 *   daily — update availability
 */
class TrueNasHub extends EventEmitter {

  constructor(options = {}) {
    super();
    // An EventEmitter with many child devices attached would otherwise warn at 10.
    this.setMaxListeners(100);

    this.homey = options.homey;
    this.systemId = options.systemId;

    this._log = options.log || (() => {});
    this._logError = options.error || (() => {});

    this.pollInterval = Math.max(15, Number(options.pollInterval) || 60) * 1000;
    this.slowPollInterval = Math.max(60, Number(options.slowPollInterval) || 300) * 1000;

    this._client = new TrueNasClient({
      host: options.host,
      port: options.port,
      useSsl: options.useSsl,
      apiKey: options.apiKey,
      rejectUnauthorized: options.rejectUnauthorized,
      log: this._log,
      error: this._logError,
    });

    this._client.on('disconnected', () => {
      this._log('Connection lost, scheduling reconnect');
      this._setUnavailable(new Error('Connection lost'), 'error.unreachable');
      this._scheduleReconnect();
    });

    this.data = this._emptyData();

    this._timer = null;
    this._reconnectTimer = null;
    this._refreshTimer = null;
    this._tick = 0;
    this._running = false;
    this._polling = false;
    this._failedGraphs = new Set();
    this._lastUpdateCheck = 0;
    this._reconnectAttempts = 0;

    this.available = false;
    this._reported = false;
    this.lastError = null;
    this.lastErrorI18n = null;
    this.lastSuccess = 0;
  }

  _emptyData() {
    return {
      system: {},
      update: {
        available: false,
        version: null,
        status: null,
        error: null,
        downloadProgress: null,
        releaseNotesUrl: null,
      },
      alerts: [],
      pools: [],
      disks: [],
      diskTemperatures: {},
      services: [],
      apps: [],
      vms: [],
      interfaces: [],
      tasks: [],
      datasets: [],
    };
  }

  /** Applies changed connection settings without losing subscribers. */
  reconfigure(options = {}) {
    if (options.pollInterval !== undefined) {
      this.pollInterval = Math.max(15, Number(options.pollInterval) || 60) * 1000;
    }
    if (options.slowPollInterval !== undefined) {
      this.slowPollInterval = Math.max(60, Number(options.slowPollInterval) || 300) * 1000;
    }

    const c = this._client;
    let reconnect = false;
    for (const key of ['host', 'port', 'useSsl', 'apiKey', 'rejectUnauthorized']) {
      if (options[key] !== undefined && options[key] !== c[key]) {
        c[key] = options[key];
        reconnect = true;
      }
    }

    if (reconnect) {
      c.disconnect();
      this._failedGraphs.clear();
    }
    if (this._running) this._restartTimer();
    if (reconnect && this._running) this.refreshNow().catch(() => {});
  }

  async start() {
    if (this._running) return;
    this._running = true;
    this._restartTimer();
    await this.refreshNow().catch(() => {});
  }

  stop() {
    this._running = false;
    this._clearTimers();
    this._client.disconnect();
  }

  _clearTimers() {
    for (const key of ['_timer', '_reconnectTimer', '_refreshTimer']) {
      if (this[key]) {
        clearTimeout(this[key]);
        clearInterval(this[key]);
        this[key] = null;
      }
    }
  }

  _restartTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      this._poll().catch((err) => this._logError('Poll cycle failed:', err.message));
    }, this.pollInterval);
  }

  _scheduleReconnect() {
    if (!this._running || this._reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * (2 ** this._reconnectAttempts));
    this._reconnectAttempts += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._poll().catch(() => {});
    }, delay);
  }

  /**
   * Debounced refresh, used after an action so the UI reflects the new state
   * without waiting a full poll interval.
   */
  scheduleRefresh(delay = 3000) {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._poll().catch(() => {});
    }, delay);
  }

  async refreshNow() {
    return this._poll(true);
  }

  /** Clears the 12-hour throttle so the next cycle re-checks for updates. */
  forceUpdateCheck() {
    this._lastUpdateCheck = 0;
  }

  /** Raw method call, used by flow actions and capability listeners. */
  async call(method, params = []) {
    return this._client.call(method, params);
  }

  /**
   * Tries each `[method, params]` pair in order, moving on only when the server
   * does not know the method. Method names drift between releases — 26.0
   * replaced `service.start` with `service.control`, for example.
   */
  async callFirst(candidates) {
    let lastError = null;
    for (const [method, params] of candidates) {
      try {
        return await this._client.call(method, params);
      } catch (err) {
        lastError = err;
        if (!err.methodMissing) throw err;
        this._log(`Method ${method} is unknown on this release, trying next`);
      }
    }
    throw lastError || new Error('No method candidate succeeded');
  }

  async _poll(force = false) {
    if (this._polling) {
      // A refresh requested while a cycle is in flight would otherwise be lost,
      // leaving the UI stale for a full interval after an action.
      this._pollAgain = true;
      return;
    }
    this._polling = true;

    try {
      await this._client.connect();
      this._reconnectAttempts = 0;

      const tick = this._tick++;
      const slowEvery = Math.max(1, Math.round(this.slowPollInterval / this.pollInterval));

      await this._pollFast();

      if (force || tick % slowEvery === 0) {
        await this._pollDisks();
        await this._pollDatasets();
      }
      if (force || Date.now() - this._lastUpdateCheck > UPDATE_CHECK_INTERVAL) {
        await this._pollUpdate();
      }

      this.lastSuccess = Date.now();
      this._setAvailable();
      this.emit('data', this.data);
    } catch (err) {
      this._setUnavailable(err, err.i18n);
      if (!this._client.connected) this._scheduleReconnect();
      throw err;
    } finally {
      this._polling = false;

      if (this._pollAgain && this._running) {
        this._pollAgain = false;
        // Deferred so the current call stack unwinds first, and never chained
        // more than one deep. Tracked so stop() can cancel it.
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => {
          this._refreshTimer = null;
          this._poll().catch((err) => this._logError('Deferred poll failed:', err.message));
        }, 250);
      }
    }
  }

  /**
   * Runs a sub-query without letting one unsupported feature break the cycle.
   * A dropped connection is rethrown, because retrying the rest is pointless.
   */
  async _safe(label, fn, fallback = null) {
    try {
      return await fn();
    } catch (err) {
      if (!this._client.connected) throw err;
      this._log(`${label} unavailable: ${err.message}`);
      return fallback;
    }
  }

  async _pollFast() {
    const info = await this._client.call('system.info');
    this.data.system = this._parseSystemInfo(info);

    const [
      pools, bootPool, services, apps, vms, alerts, interfaces,
      cloudsync, replication, snapshotTasks,
    ] = await Promise.all([
      this._safe('pool.query', () => this._client.call('pool.query'), []),
      this._safe('boot.get_state', () => this._client.call('boot.get_state'), null),
      this._safe('service.query', () => this._client.call('service.query'), []),
      this._safe('app.query', () => this._client.call('app.query'), []),
      this._safe('vm.query', () => this._client.call('vm.query'), []),
      this._safe('alert.list', () => this._client.call('alert.list'), []),
      this._safe('interface.query', () => this._client.call('interface.query'), []),
      this._safe('cloudsync.query', () => this._client.call('cloudsync.query'), []),
      this._safe('replication.query', () => this._client.call('replication.query'), []),
      this._safe('pool.snapshottask.query', () => this._client.call('pool.snapshottask.query'), []),
    ]);

    this.data.pools = this._parsePools(pools || [], bootPool);
    this.data.services = (services || []).map((s) => this._parseService(s));
    this.data.apps = (apps || []).map((a) => this._parseApp(a));
    this.data.vms = await this._parseVms(vms || []);
    this.data.alerts = this._parseAlerts(alerts || []);
    this.data.interfaces = (interfaces || []).map((i) => this._parseInterface(i));
    this.data.tasks = this._parseTasks(cloudsync, replication, snapshotTasks);

    await this._pollReporting();
  }

  async _pollDisks() {
    // `pool` stays null unless the `pools` extra is requested — the middleware
    // only resolves vdev GUIDs to pool names on demand.
    const disks = await this._safe(
      'disk.query',
      () => this._client.call('disk.query', [[], { extra: { pools: true } }]),
      null,
    );
    if (!Array.isArray(disks)) return;

    this.data.disks = disks.map((d) => ({
      identifier: d.identifier,
      name: d.name,
      devname: d.devname,
      serial: d.serial,
      model: d.model,
      size: d.size,
      type: d.type,
      rotationrate: d.rotationrate,
      bus: d.bus,
      pool: d.pool,
      description: d.description,
    }));

    const names = this.data.disks.map((d) => d.name).filter(Boolean);
    if (!names.length) return;

    const temps = await this._safe(
      'disk.temperatures',
      () => this._client.call('disk.temperatures', [names, false]),
      null,
    );
    if (temps && typeof temps === 'object') {
      this.data.diskTemperatures = temps;
    }
  }

  /** Datasets sit on the slow tier because a NAS can easily have hundreds. */
  async _pollDatasets() {
    const datasets = await this._safe(
      'pool.dataset.query',
      () => this._client.call('pool.dataset.query'),
      null,
    );
    if (!Array.isArray(datasets)) return;
    this.data.datasets = datasets.map((ds) => this._parseDataset(ds));
  }

  async _pollUpdate() {
    this._lastUpdateCheck = Date.now();

    // 25.10 (Goldeye) replaced update.check_available with update.status and a
    // completely different response shape.
    const result = await this._safe(
      'update status',
      () => this.callFirst([
        ['update.status', []],
        ['update.check_available', []],
      ]),
      null,
    );
    if (!result) return;

    this.data.update = typeof result.code === 'string'
      ? this._parseUpdateStatus(result)
      : this._parseLegacyUpdate(result);
  }

  /** Response of `update.status` (TrueNAS 25.10 and later). */
  _parseUpdateStatus(result) {
    const fallbackVersion = this.data.system.version || null;

    if (result.code === 'ERROR') {
      return {
        available: false,
        version: fallbackVersion,
        status: 'ERROR',
        error: get(result, 'error/reason'),
        downloadProgress: null,
        releaseNotesUrl: null,
      };
    }

    const newVersion = get(result, 'status/new_version');
    return {
      available: Boolean(newVersion),
      version: get(result, 'status/new_version/version') || fallbackVersion,
      status: newVersion ? 'AVAILABLE' : 'UNAVAILABLE',
      error: null,
      downloadProgress: get(result, 'update_download_progress/percent'),
      releaseNotesUrl: get(result, 'status/new_version/release_notes_url'),
    };
  }

  /** Response of `update.check_available` (TrueNAS 25.04 and earlier). */
  _parseLegacyUpdate(result) {
    const status = get(result, 'status');
    return {
      available: status === 'AVAILABLE',
      version: get(result, 'version') || this.data.system.version || null,
      status,
      error: null,
      downloadProgress: null,
      releaseNotesUrl: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Reporting (netdata) graphs
  // ---------------------------------------------------------------------------

  async _pollReporting() {
    const graphs = [];
    for (const name of ['load', 'cpu', 'memory', 'arcsize', 'cputemp']) {
      // system.info already gave us the load averages this cycle.
      if (name === 'load' && this._loadFromSystemInfo) continue;
      if (!this._failedGraphs.has(name)) graphs.push({ name });
    }

    if (!this._failedGraphs.has('interface')) {
      const active = this.data.interfaces
        .filter((i) => i.linkState === 'LINK_STATE_UP')
        .slice(0, MAX_INTERFACE_GRAPHS);
      for (const iface of active) {
        graphs.push({ name: 'interface', identifier: iface.id });
      }
    }

    if (!graphs.length) return;

    const now = Math.floor(Date.now() / 1000);
    const result = await this._safe(
      'reporting.netdata_get_data',
      () => this._client.call('reporting.netdata_get_data', [
        graphs,
        { start: now - 180, end: now, aggregate: true },
      ]),
      null,
    );

    if (!Array.isArray(result)) {
      // Probe one by one so a single unsupported graph does not disable them all.
      await this._probeFailedGraphs(graphs, now);
      return;
    }

    let rxTotal = 0;
    let txTotal = 0;
    let hasInterfaceData = false;

    for (const graph of result) {
      const mean = get(graph, 'aggregations/mean', null);
      if (!mean || typeof mean !== 'object') continue;

      switch (graph.name) {
        case 'load':
          this.data.system.load1 = round(mean.shortterm, 2);
          this.data.system.load5 = round(mean.midterm, 2);
          this.data.system.load15 = round(mean.longterm, 2);
          break;

        case 'cpu':
          this.data.system.cpuUsage = this._cpuUsageFromMean(mean);
          break;

        case 'cputemp': {
          const values = Object.values(mean).map(Number).filter(Number.isFinite);
          if (values.length) this.data.system.cpuTemperature = round(Math.max(...values), 1);
          break;
        }

        case 'memory':
          this._applyMemory(mean);
          break;

        case 'arcsize': {
          const arc = mean.arc_size !== undefined ? mean.arc_size : Object.values(mean)[0];
          this.data.system.arcSize = this._normaliseBytes(arc);
          break;
        }

        case 'interface': {
          // netdata reports interface throughput in kilobits per second.
          const rx = Number(mean.received) || 0;
          const tx = Number(mean.sent) || 0;
          rxTotal += Math.abs(rx);
          txTotal += Math.abs(tx);
          hasInterfaceData = true;
          break;
        }

        default:
          break;
      }
    }

    if (hasInterfaceData) {
      this.data.system.networkRx = round(rxTotal / 1000, 2);
      this.data.system.networkTx = round(txTotal / 1000, 2);
    }
  }

  async _probeFailedGraphs(graphs, now) {
    for (const graph of graphs) {
      try {
        await this._client.call('reporting.netdata_get_data', [
          [graph],
          { start: now - 180, end: now, aggregate: true },
        ]);
      } catch (_err) {
        if (!this._client.connected) return;
        this._failedGraphs.add(graph.name);
        this._log(`Reporting graph "${graph.name}" is not available on this system`);
      }
    }
  }

  /**
   * netdata's cpu chart exposes a total under `cpu`; older layouts only provide
   * the per-state breakdown, in which case everything but idle is the usage.
   */
  _cpuUsageFromMean(mean) {
    if (toNumber(mean.cpu) !== null) return round(mean.cpu, 1);

    if (toNumber(mean.idle) !== null) {
      const busy = Object.entries(mean)
        .filter(([key]) => key !== 'idle')
        .map(([, value]) => Number(value))
        .filter(Number.isFinite)
        .reduce((sum, value) => sum + value, 0);
      return round(Math.min(100, Math.max(0, busy)), 1);
    }
    return null;
  }

  _applyMemory(mean) {
    const total = Number(this.data.system.memoryTotal);
    const free = this._normaliseBytes(
      mean.available !== undefined ? mean.available : mean.free,
      total,
    );

    if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return;

    this.data.system.memoryFree = free;
    this.data.system.memoryUsed = Math.max(0, total - free);
    this.data.system.memoryUsage = percent(total - free, total, 0);
  }

  /**
   * Reporting values arrive in bytes on current releases but in MiB on some
   * older netdata layouts. If a value is implausibly small next to total RAM,
   * assume MiB.
   */
  _normaliseBytes(value, reference = null) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const ref = Number(reference);
    if (Number.isFinite(ref) && ref > 0 && num > 0 && num < ref / 1000) {
      return num * 1024 * 1024;
    }
    return num;
  }

  // ---------------------------------------------------------------------------
  // Parsers
  // ---------------------------------------------------------------------------

  _parseSystemInfo(info) {
    const uptimeSeconds = Number(get(info, 'uptime_seconds', 0)) || 0;

    // system.info carries the load averages directly, which is both cheaper and
    // more reliable than the netdata `load` graph.
    const loadavg = get(info, 'loadavg');
    const load = Array.isArray(loadavg) && loadavg.length >= 3
      ? { load1: round(loadavg[0], 2), load5: round(loadavg[1], 2), load15: round(loadavg[2], 2) }
      : {};
    this._loadFromSystemInfo = Object.keys(load).length > 0;

    return {
      // Reporting values are merged in afterwards, so keep the previous ones.
      ...this.data.system,
      hostname: get(info, 'hostname'),
      version: shortVersion(get(info, 'version')),
      versionFull: get(info, 'version'),
      serial: get(info, 'system_serial'),
      product: get(info, 'system_product'),
      manufacturer: get(info, 'system_manufacturer'),
      model: get(info, 'model'),
      cores: get(info, 'cores'),
      memoryTotal: Number(get(info, 'physmem', 0)) || 0,
      uptimeSeconds,
      uptime: formatUptime(uptimeSeconds),
      bootTime: uptimeSeconds > 0 ? new Date(Date.now() - uptimeSeconds * 1000).toISOString() : null,
      ...load,
    };
  }

  _parsePools(pools, bootPool) {
    const parsed = pools.map((pool) => this._parsePool(pool, false));

    if (bootPool && bootPool.name) {
      // boot.get_state returns a PoolEntry with id and guid excluded, so the
      // size fields are already there — no need to derive them.
      parsed.push(this._parsePool({
        ...bootPool,
        id: bootPool.id || `boot-${bootPool.name}`,
      }, true));
    }

    return parsed;
  }

  _parsePool(pool, isBoot) {
    const size = Number(get(pool, 'size', 0)) || 0;
    const allocated = Number(get(pool, 'allocated', 0)) || 0;
    const free = Number(get(pool, 'free', 0)) || 0;
    const status = get(pool, 'status', 'UNKNOWN');

    return {
      id: String(get(pool, 'id', pool.name)),
      name: get(pool, 'name'),
      isBoot,
      status,
      healthy: get(pool, 'healthy') === true || (isBoot && status === 'ONLINE'),
      warning: get(pool, 'warning') === true,
      statusDetail: get(pool, 'status_detail'),
      size,
      allocated,
      free,
      usage: percent(allocated, size, 1),
      scrubFunction: get(pool, 'scan/function'),
      scrubState: get(pool, 'scan/state'),
      scrubProgress: round(get(pool, 'scan/percentage', 0), 1),
      scrubErrors: get(pool, 'scan/errors'),
      scrubSecondsLeft: get(pool, 'scan/total_secs_left'),
      scrubEndTime: get(pool, 'scan/end_time/$date') || get(pool, 'scan/end_time'),
    };
  }

  _parseService(service) {
    return {
      id: service.id,
      service: service.service,
      state: service.state,
      running: service.state === 'RUNNING',
      enable: service.enable === true,
    };
  }

  _parseApp(app) {
    return {
      id: app.id,
      name: app.name,
      state: app.state,
      running: app.state === 'RUNNING',
      version: get(app, 'human_version') || get(app, 'version'),
      latestVersion: get(app, 'latest_version'),
      // A catalog upgrade and a newer container image are tracked separately
      // by TrueNAS, and either can be pending without the other.
      upgradeAvailable: app.upgrade_available === true,
      imageUpdates: app.image_updates_available === true,
      custom: app.custom_app === true,
      containers: Number(get(app, 'active_workloads/containers', 0)) || 0,
      portal: this._extractPortal(get(app, 'portals')),
    };
  }

  /**
   * `portals` maps a label to a URL, e.g. `{ "Web UI": "http://nas:32400" }`.
   * Prefers an entry that looks like the main interface.
   */
  _extractPortal(portals) {
    if (!portals || typeof portals !== 'object') return null;

    const entries = Object.entries(portals)
      .filter(([, value]) => typeof value === 'string' && value.length);
    if (!entries.length) return null;

    const preferred = entries.find(([label]) => /web|ui|portal/i.test(label));
    return (preferred || entries[0])[1];
  }

  async _parseVms(vms) {
    const result = [];
    for (const vm of vms) {
      // vm.query embeds a status object on current releases; fall back to
      // vm.status only when it is missing.
      let state = get(vm, 'status/state');
      if (!state) {
        const status = await this._safe(
          'vm.status',
          () => this._client.call('vm.status', [vm.id]),
          null,
        );
        state = get(status, 'state');
      }
      result.push({
        id: vm.id,
        name: vm.name,
        description: vm.description,
        state: state || 'UNKNOWN',
        running: state === 'RUNNING',
        memory: Number(get(vm, 'memory', 0)) || 0,
        vcpus: get(vm, 'vcpus'),
        autostart: get(vm, 'autostart') === true,
      });
    }
    return result;
  }

  _parseAlerts(alerts) {
    return alerts
      .filter((a) => a && a.dismissed !== true)
      .map((a) => ({
        id: a.id,
        uuid: a.uuid,
        level: a.level,
        severity: Math.max(0, ALERT_LEVELS.indexOf(a.level)),
        klass: a.klass,
        text: a.formatted || a.text,
        datetime: get(a, 'datetime/$date') || get(a, 'datetime'),
      }))
      .sort((a, b) => b.severity - a.severity);
  }

  /**
   * Cloudsync, replication and periodic snapshot tasks share a shape: a name,
   * a state and a last run. They differ only in where those live, so they are
   * normalised into one list.
   */
  _parseTasks(cloudsync, replication, snapshotTasks) {
    return [
      ...(cloudsync || []).map((t) => this._parseJobTask('cloudsync', t, t.description, t.path)),
      ...(replication || []).map((t) => this._parseJobTask('replication', t, t.name, t.target_dataset)),
      ...(snapshotTasks || []).map((t) => this._parseSnapshotTask(t)),
    ];
  }

  _parseJobTask(type, task, label, path) {
    const state = get(task, 'job/state');
    return {
      key: `${type}:${task.id}`,
      type,
      id: task.id,
      name: label || `${type} ${task.id}`,
      path: Array.isArray(path) ? path.join(', ') : (path || null),
      enabled: task.enabled === true,
      state: state || 'UNKNOWN',
      running: state === 'RUNNING',
      failed: FAILED_TASK_STATES.includes(state),
      progress: toNumber(get(task, 'job/progress/percent')),
      progressText: get(task, 'job/progress/description'),
      lastRun: this._epochMsToIso(get(task, 'job/time_finished/$date')),
    };
  }

  _parseSnapshotTask(task) {
    // Periodic snapshot tasks report under `state`, not `job`.
    const state = get(task, 'state/state');
    return {
      key: `snapshot:${task.id}`,
      type: 'snapshot',
      id: task.id,
      name: task.dataset || `snapshot ${task.id}`,
      path: task.dataset || null,
      enabled: task.enabled === true,
      state: state || 'UNKNOWN',
      running: state === 'RUNNING',
      failed: FAILED_TASK_STATES.includes(state),
      progress: null,
      progressText: null,
      lastRun: this._epochMsToIso(get(task, 'state/datetime/$date')),
    };
  }

  _epochMsToIso(value) {
    const ms = toNumber(value);
    if (ms === null || ms <= 0) return null;
    return new Date(ms).toISOString();
  }

  _parseDataset(ds) {
    // Dataset properties arrive as objects; the usable number is under `parsed`.
    const used = toNumber(get(ds, 'used/parsed'));
    const available = toNumber(get(ds, 'available/parsed'));
    const total = used !== null && available !== null ? used + available : null;

    return {
      id: ds.id,
      name: ds.name,
      pool: ds.pool,
      type: ds.type,
      mountpoint: ds.mountpoint,
      used,
      available,
      total,
      usage: percent(used, total, 1),
      quota: toNumber(get(ds, 'quota/parsed')),
      compression: get(ds, 'compression/parsed'),
      compressRatio: get(ds, 'compressratio/parsed'),
      encrypted: Boolean(get(ds, 'encryption_algorithm/parsed')),
    };
  }

  _parseInterface(iface) {
    return {
      id: iface.id,
      name: iface.name,
      description: iface.description,
      linkState: get(iface, 'state/link_state'),
      linkAddress: get(iface, 'state/link_address'),
      mediaType: get(iface, 'state/active_media_type'),
    };
  }

  // ---------------------------------------------------------------------------
  // Derived helpers used by devices
  // ---------------------------------------------------------------------------

  /**
   * False once a reporting graph has been confirmed unsupported by the server —
   * `cputemp` is absent on virtualised TrueNAS installs, for example.
   */
  isGraphAvailable(name) {
    return !this._failedGraphs.has(name);
  }

  get criticalAlerts() {
    const threshold = ALERT_LEVELS.indexOf(ALARM_FROM_LEVEL);
    return this.data.alerts.filter((a) => a.severity >= threshold);
  }

  getPool(name) {
    return this.data.pools.find((p) => p.name === name) || null;
  }

  getDisk(identifier) {
    return this.data.disks.find((d) => d.identifier === identifier) || null;
  }

  getDiskTemperature(disk) {
    if (!disk) return null;
    // TrueNAS returns null for disks it could not read, e.g. spun down ones.
    return toNumber(this.data.diskTemperatures[disk.name]);
  }

  getService(name) {
    return this.data.services.find((s) => s.service === name) || null;
  }

  getApp(name) {
    return this.data.apps.find((a) => a.name === name || a.id === name) || null;
  }

  getTask(key) {
    return this.data.tasks.find((t) => t.key === key) || null;
  }

  getDataset(id) {
    return this.data.datasets.find((d) => d.id === id) || null;
  }

  getVm(id) {
    return this.data.vms.find((v) => String(v.id) === String(id)) || null;
  }

  _setAvailable() {
    this.lastError = null;
    this.lastErrorI18n = null;

    // `_reported` matters for the very first cycle: the hub starts out
    // unavailable, so without it a NAS that is unreachable from the start
    // would never emit anything and its devices would sit there looking fine.
    const changed = !this.available || !this._reported;
    this.available = true;
    this._reported = true;
    if (changed) this.emit('available');
  }

  _setUnavailable(err, i18n = null) {
    this.lastError = err ? err.message : 'Unknown error';
    this.lastErrorI18n = i18n || (err && err.i18n) || 'error.unreachable';

    const changed = this.available || !this._reported;
    this.available = false;
    this._reported = true;
    if (changed) this.emit('unavailable', this.lastErrorI18n);
  }

}

module.exports = TrueNasHub;
