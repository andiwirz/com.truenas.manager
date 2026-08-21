'use strict';

const { humanBytes, toNumber } = require('./lib/util');

/** `12.5 TB`, or null when the value is missing rather than zero. */
function size(bytes) {
  const { value, unit } = humanBytes(bytes);
  return value === null ? null : `${value} ${unit}`;
}

/**
 * `2026-08-20 22:53` in the Homey's own timezone.
 *
 * Alerts arrive as `{"$date": 1787259230000}` and tasks as an ISO string, so
 * both shapes land here. sv-SE is used deliberately: it renders as
 * YYYY-MM-DD HH:MM, which reads the same whatever language the page is in.
 */
function when(value, timezone) {
  if (value === null || value === undefined) return null;

  const ms = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;

  try {
    return new Date(ms).toLocaleString('sv-SE', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (_err) {
    // An unknown timezone should cost the local offset, not the timestamp.
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
  }
}

/**
 * TrueNAS alert levels run INFO, NOTICE, WARNING, ERROR, CRITICAL, ALERT,
 * EMERGENCY. Only WARNING and above are a problem — "replication succeeded"
 * is an INFO and must not be painted like a fault.
 */
function alertTone(severity) {
  if (severity >= 3) return 'alarm';
  if (severity === 2) return 'warn';
  return 'muted';
}

/**
 * Turns one hub record into the shape the settings page renders: a title, a
 * language-neutral subtitle (numbers and units only), a raw TrueNAS state for
 * the badge, and flag keys the page translates itself.
 */
const DETAIL = {
  pools: (hub) => hub.data.pools.map((p) => ({
    id: String(p.id),
    title: p.name,
    sub: [size(p.allocated), size(p.size)].every(Boolean)
      ? `${size(p.allocated)} / ${size(p.size)}`
      : null,
    state: p.scrubState === 'SCANNING' ? 'SCRUB' : p.status,
    tone: p.healthy ? (p.warning ? 'warn' : 'ok') : 'alarm',
    meter: p.usage,
    flags: p.isBoot ? ['boot'] : [],
  })),

  disks: (hub) => hub.data.disks.map((d) => {
    const temp = toNumber(hub.data.diskTemperatures[d.name]);
    return {
      id: d.identifier || d.name,
      title: d.name,
      sub: [size(d.size), d.model].filter(Boolean).join(' · ') || null,
      state: temp === null ? null : `${temp} °C`,
      // Warm rather than broken: 50 °C is the usual limit for spinning disks.
      tone: temp === null ? 'muted' : (temp >= 50 ? 'warn' : 'ok'),
      meter: null,
      flags: d.pool ? [] : ['unassigned'],
      note: d.pool || null,
    };
  }),

  services: (hub) => hub.data.services.map((s) => ({
    id: String(s.id),
    title: s.service,
    sub: null,
    state: s.state,
    tone: s.running ? 'ok' : 'muted',
    meter: null,
    flags: s.enable ? ['autostart'] : [],
  })),

  apps: (hub) => hub.data.apps.map((a) => ({
    id: a.id,
    title: a.name,
    sub: a.version || null,
    state: a.state,
    tone: a.running ? 'ok' : (a.state === 'CRASHED' ? 'alarm' : 'muted'),
    meter: null,
    flags: [
      ...(a.upgradeAvailable ? ['update'] : []),
      ...(a.imageUpdates ? ['image'] : []),
    ],
  })),

  vms: (hub) => hub.data.vms.map((v) => ({
    id: String(v.id),
    title: v.name,
    sub: [v.vcpus ? `${v.vcpus} vCPU` : null, v.memory ? size(v.memory * 1024 * 1024) : null]
      .filter(Boolean).join(' · ') || null,
    state: v.state,
    tone: v.running ? 'ok' : 'muted',
    meter: null,
    flags: v.autostart ? ['autostart'] : [],
  })),

  tasks: (hub, tz) => hub.data.tasks.map((t) => ({
    id: t.key,
    title: t.name,
    sub: when(t.lastRun, tz),
    state: t.state,
    tone: t.failed ? 'alarm' : (t.running ? 'warn' : 'ok'),
    meter: t.running ? t.progress : null,
    flags: t.enabled ? [] : ['disabled'],
    note: t.type,
  })),

  alerts: (hub, tz) => hub.data.alerts.map((a) => ({
    id: String(a.uuid || a.id),
    title: a.text,
    sub: when(a.datetime, tz),
    state: a.level,
    tone: alertTone(a.severity),
    meter: null,
    flags: [],
  })),
};

// Problems first: a list of forty disks is only useful if the hot one is at
// the top. Ties keep their natural order, which is already name-sorted.
const TONE_ORDER = { alarm: 0, warn: 1, ok: 2, muted: 3 };

module.exports = {

  /** Overview of every paired TrueNAS system and its live counters. */
  async getSystems({ homey }) {
    const app = homey.app;

    let devices = [];
    try {
      const driver = homey.drivers.getDriver('truenas-system');
      devices = driver ? driver.getDevices() : [];
    } catch (_err) {
      // Driver not ready yet — an empty list is better than a failed page.
      return [];
    }

    return devices.map((device) => {
      const systemId = device.getData().id;
      const hub = app.getHub(systemId);
      const settings = device.getSettings();

      return {
        systemId,
        name: device.getName(),
        host: settings.host,
        port: settings.port,
        protocol: settings.use_ssl ? 'https' : 'http',
        available: hub ? hub.available : false,
        lastError: hub ? hub.lastError : 'Not initialized',
        lastSuccess: hub ? hub.lastSuccess : 0,
        version: hub ? hub.data.system.version : null,
        hostname: hub ? hub.data.system.hostname : null,
        uptime: hub ? hub.data.system.uptime : null,
        counts: hub ? {
          pools: hub.data.pools.length,
          disks: hub.data.disks.length,
          services: hub.data.services.length,
          apps: hub.data.apps.length,
          vms: hub.data.vms.length,
          tasks: hub.data.tasks.length,
          alerts: hub.data.alerts.length,
          // Counted separately so the tile only turns red for something that
          // is actually wrong. TrueNAS files routine successes as INFO alerts.
          alertsSevere: hub.data.alerts.filter((a) => a.severity >= 2).length,
        } : null,
      };
    });
  },

  /** Raw hub data, so users can verify readings before reporting an issue. */
  async getDebug({ homey, query }) {
    const hub = homey.app.getHub(query.systemId);
    if (!hub) throw new Error('Unknown system');

    return {
      system: hub.data.system,
      update: hub.data.update,
      pools: hub.data.pools,
      disks: hub.data.disks,
      diskTemperatures: hub.data.diskTemperatures,
      services: hub.data.services,
      apps: hub.data.apps,
      vms: hub.data.vms,
      interfaces: hub.data.interfaces,
      alerts: hub.data.alerts,
    };
  },

  /** One category of a system, expanded under its tile on the settings page. */
  async getSystemDetails({ homey, query }) {
    const hub = homey.app.getHub(query.systemId);
    if (!hub) throw new Error('Unknown system');

    const build = DETAIL[query.kind];
    if (!build) throw new Error(`Unknown kind: ${query.kind}`);

    let timezone = null;
    try {
      timezone = homey.clock.getTimezone();
    } catch (_err) {
      // Fall back to the host's own timezone rather than losing the timestamp.
    }

    const items = build(hub, timezone)
      .map((item) => ({ note: null, ...item }))
      .sort((a, b) => (TONE_ORDER[a.tone] ?? 9) - (TONE_ORDER[b.tone] ?? 9));

    return { kind: query.kind, items };
  },

  async refreshSystem({ homey, query }) {
    const hub = homey.app.getHub(query.systemId);
    if (!hub) throw new Error('Unknown system');
    await hub.refreshNow();
    return { ok: true };
  },

  /**
   * Runs the same checks the standalone diagnose script performs, but through
   * the connection that is already paired, so no credentials are needed.
   */
  async runDiagnostics({ homey, query }) {
    const hub = homey.app.getHub(query.systemId);
    if (!hub) throw new Error('Unknown system');

    const checks = [];
    const probe = async (id, label, fn) => {
      const started = Date.now();
      try {
        const detail = await fn();
        checks.push({
          id, label, ok: true, detail: detail || null, ms: Date.now() - started,
        });
      } catch (err) {
        checks.push({
          id, label, ok: false, detail: err.message, ms: Date.now() - started,
        });
      }
    };

    await probe('connect', 'Connection', async () => {
      await hub.call('core.ping').catch(() => null);
      return hub.available ? 'reachable' : null;
    });

    await probe('system', 'System information', async () => {
      const info = await hub.call('system.info');
      return `${info.hostname} — ${info.version}`;
    });

    await probe('pools', 'Storage pools', async () => {
      const pools = await hub.call('pool.query');
      return `${pools.length} pool(s)`;
    });

    await probe('disks', 'Disks and temperatures', async () => {
      const disks = await hub.call('disk.query', [[], { extra: { pools: true } }]);
      const named = disks.map((d) => d.name).filter(Boolean);
      const withPool = disks.filter((d) => d.pool).length;
      if (!named.length) return '0 disks';
      const temps = await hub.call('disk.temperatures', [named, false]);
      const read = Object.values(temps).filter((t) => t !== null && t !== undefined).length;
      return `${disks.length} disk(s), ${withPool} assigned to a pool, ${read} temperature(s) read`;
    });

    await probe('reporting', 'Performance graphs', async () => {
      const now = Math.floor(Date.now() / 1000);
      const result = await hub.call('reporting.netdata_get_data', [
        [{ name: 'cpu' }, { name: 'memory' }],
        { start: now - 180, end: now, aggregate: true },
      ]);
      if (!Array.isArray(result) || !result.length) throw new Error('No data returned');
      return result.map((g) => g.name).join(', ');
    });

    await probe('update', 'Update check', async () => {
      const status = await hub.call('update.status');
      if (status.code === 'ERROR') throw new Error(status.error?.reason || 'error');
      return status.status?.new_version ? 'update available' : 'up to date';
    });

    await probe('tasks', 'Backup tasks', async () => {
      const [cloud, repl, snap] = await Promise.all([
        hub.call('cloudsync.query'),
        hub.call('replication.query'),
        hub.call('pool.snapshottask.query'),
      ]);
      return `${cloud.length} cloud sync, ${repl.length} replication, ${snap.length} snapshot`;
    });

    return {
      checks,
      failed: checks.filter((c) => !c.ok).length,
      host: hub.data.system.hostname || null,
    };
  },

  async getAppSettings({ homey }) {
    return { verbose_log: homey.settings.get('verbose_log') === true };
  },

  async setAppSettings({ homey, body }) {
    if (body && typeof body.verbose_log === 'boolean') {
      homey.settings.set('verbose_log', body.verbose_log);
    }
    return { verbose_log: homey.settings.get('verbose_log') === true };
  },

  async getLog({ homey }) {
    return homey.app.getLog();
  },

  async clearLog({ homey }) {
    homey.app.clearLog();
    return { ok: true };
  },

};
