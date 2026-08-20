'use strict';

/**
 * End-to-end harness for the device layer.
 *
 * Stubs the `homey` and `ws` modules, then drives the real App, Driver and
 * Device classes against a fake TrueNAS speaking real JSON-RPC. This covers
 * what the unit test does not: capability wiring, listener registration,
 * flow-card bindings, settings toggles and teardown.
 */

const Module = require('module');
const EventEmitter = require('events');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GIB = 1024 ** 3;

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ok    ${label} = ${JSON.stringify(actual)}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}
function note(label) { console.log(`\n${label}`); }

// ---------------------------------------------------------------------------
// Fake TrueNAS
// ---------------------------------------------------------------------------

const RESPONSES = {
  'system.info': {
    version: 'TrueNAS-SCALE-25.10.0', hostname: 'nas', uptime_seconds: 90061,
    system_serial: 'SN1', system_product: 'Custom', system_manufacturer: 'ASUS',
    physmem: 32 * GIB, cores: 8, model: 'CPU', loadavg: [1.2, 0.9, 0.7],
  },
  'system.host_id': 'host-id-abc',
  'pool.query': [{
    id: 1, name: 'tank', status: 'ONLINE', healthy: true, warning: false,
    status_detail: null, size: 8 * 1024 * GIB, allocated: 2 * 1024 * GIB,
    free: 6 * 1024 * GIB,
    scan: { function: 'SCRUB', state: 'FINISHED', percentage: 100, errors: 0 },
  }],
  'boot.get_state': {
    name: 'boot-pool', status: 'ONLINE', healthy: true, warning: false,
    status_detail: null, size: 100 * GIB, allocated: 20 * GIB, free: 80 * GIB,
    scan: { function: 'SCRUB', state: 'FINISHED', percentage: 100, errors: 0 },
  },
  'service.query': [
    { id: 1, service: 'cifs', enable: true, state: 'RUNNING', pids: [1] },
    { id: 2, service: 'nfs', enable: false, state: 'STOPPED', pids: [] },
  ],
  'app.query': [{
    id: 'plex', name: 'plex', state: 'RUNNING', upgrade_available: true,
    latest_version: '2.0.0', image_updates_available: true, custom_app: false,
    migrated: false, human_version: '1.0.0_1.2.3', version: '1.2.3',
    portals: { 'Web UI': 'http://nas:32400/web' },
    active_workloads: {
      containers: 2, used_ports: [], used_host_ips: [], container_details: [],
      volumes: [], images: [], networks: [],
    },
  }],
  'vm.query': [{
    id: 7, name: 'Ubuntu', description: '', memory: 8192, vcpus: 4,
    autostart: true, status: { state: 'RUNNING' },
  }],
  'alert.list': [{
    uuid: 'u1', id: 'a1', level: 'CRITICAL', klass: 'PoolStatus',
    text: 'Pool tank is degraded', formatted: 'Pool <b>tank</b> is degraded',
    dismissed: false, datetime: { $date: 1700000000000 },
  }],
  'interface.query': [{
    id: 'eno1', name: 'eno1', description: '',
    state: { link_state: 'LINK_STATE_UP', link_address: 'aa:bb', active_media_type: 'Ethernet' },
  }],
  'disk.query': [{
    identifier: 'ID-SDA', name: 'sda', devname: '/dev/sda', serial: 'S1',
    model: 'WDC WD40EFRX', size: 4 * 1024 * GIB, type: 'HDD', rotationrate: 5400,
    bus: 'ATA', pool: 'tank', description: '',
  }],
  'disk.temperatures': { sda: 41 },
  'cloudsync.query': [{
    id: 3, description: 'Backblaze photos', direction: 'PUSH', path: '/mnt/tank/photos',
    enabled: true, transfer_mode: 'SYNC', snapshot: false,
    job: { state: 'SUCCESS', time_finished: { $date: 1700000000000 }, progress: { percent: 100, description: 'done' } },
  }, {
    id: 4, description: 'Offsite docs', direction: 'PUSH', path: '/mnt/tank/docs', enabled: true,
    job: { state: 'FAILED', time_finished: { $date: 1700000500000 }, progress: { percent: 12, description: 'auth error' } },
  }],
  'replication.query': [{
    id: 9, name: 'tank to backup', source_datasets: ['tank/data'], target_dataset: 'backup/data',
    enabled: true, direction: 'PUSH', transport: 'SSH',
    job: { state: 'RUNNING', time_finished: null, progress: { percent: 42, description: 'sending' } },
  }],
  'pool.snapshottask.query': [{
    id: 2, dataset: 'tank/vm', recursive: true, enabled: true, naming_schema: 'auto-%Y%m%d',
    state: { state: 'FINISHED', datetime: { $date: 1700000900000 } },
  }],
  'pool.dataset.query': [{
    id: 'tank/data', name: 'tank/data', pool: 'tank', type: 'FILESYSTEM', mountpoint: '/mnt/tank/data',
    used: { parsed: 200 * GIB }, available: { parsed: 300 * GIB }, quota: { parsed: 0 },
    compression: { parsed: 'lz4' }, compressratio: { parsed: '1.75x' }, encryption_algorithm: { parsed: null },
  }, {
    id: 'tank/vmdisk', name: 'tank/vmdisk', pool: 'tank', type: 'VOLUME', mountpoint: null,
    used: { parsed: 50 * GIB }, available: { parsed: 100 * GIB },
  }],
  'cloudsync.sync': null,
  'cloudsync.abort': null,
  'replication.run': null,
  'pool.snapshottask.run': null,
  'pool.snapshot.create': { name: 'ok' },
  'update.status': {
    code: 'NORMAL',
    status: {
      current_version: { train: 'GOLDEYE', profile: 'GENERAL', matches_profile: true },
      new_version: {
        version: '25.10.1', manifest: {}, release_notes: null,
        release_notes_url: 'http://x',
      },
    },
    error: null,
    update_download_progress: null,
  },
  'reporting.netdata_get_data': [
    { name: 'cpu', identifier: null, legend: ['cpu'], aggregations: { mean: { cpu: 20 } } },
    { name: 'memory', identifier: null, legend: ['available'], aggregations: { mean: { available: 24 * GIB } } },
    { name: 'arcsize', identifier: null, legend: ['arc_size'], aggregations: { mean: { arc_size: 8 * GIB } } },
    { name: 'cputemp', identifier: null, legend: ['0'], aggregations: { mean: { 0: 52 } } },
    { name: 'interface', identifier: 'eno1', legend: ['received', 'sent'], aggregations: { mean: { received: 4000, sent: 1000 } } },
  ],
  // Write methods.
  'service.control': true,
  'app.upgrade': {},
  'app.redeploy': {},
  'app.start': null,
  'app.stop': null,
  'vm.start': null,
  'vm.stop': null,
  'vm.restart': null,
  'vm.poweroff': null,
  'pool.scrub.scrub': null,
  'boot.scrub': null,
  'system.reboot': null,
  'system.shutdown': null,
  'update.run': true,
};

const rpcCalls = [];

class FakeWebSocket extends EventEmitter {

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    // A host named "unreachable" simulates a refused connection.
    if (String(url).includes('unreachable')) {
      setImmediate(() => this.emit('error', new Error('connect ECONNREFUSED')));
      return;
    }
    setImmediate(() => this.emit('open'));
  }

  send(raw) {
    const msg = JSON.parse(raw);
    rpcCalls.push({ method: msg.method, params: msg.params });
    setImmediate(() => {
      const reply = (payload) => this.emit(
        'message',
        Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload })),
      );
      if (msg.method === 'auth.login_with_api_key') {
        reply({ result: true });
        return;
      }
      if (!(msg.method in RESPONSES)) {
        reply({ error: { code: -32601, message: 'Method not found' } });
        return;
      }
      reply({ result: RESPONSES[msg.method] });
    });
  }

  ping() { setImmediate(() => this.emit('pong')); }
  terminate() { this.readyState = 3; }
  close() { this.readyState = 3; this.emit('close'); }

}
FakeWebSocket.OPEN = 1;

// ---------------------------------------------------------------------------
// Fake homey module
// ---------------------------------------------------------------------------

class Base {

  log() {}
  error() {}

}

class Device extends Base {

  constructor(opts) {
    super();
    this._data = opts.data;
    this._name = opts.name;
    this._settings = { ...opts.settings };
    this._store = { ...opts.store };
    this._caps = new Map(opts.capabilities.map((c) => [c, null]));
    this._listeners = new Map();
    this.duplicateListeners = [];
    this.invalidCapabilityWrites = [];
    this._available = true;
    this.unavailableReason = null;
    this.homey = opts.homey;
  }

  getData() { return this._data; }
  getId() { return `homey-${this._data.id}`; }
  getName() { return this._name; }
  getSettings() { return { ...this._settings }; }
  getSetting(key) { return this._settings[key]; }
  async setSettings(values) { Object.assign(this._settings, values); }
  getStoreValue(key) { return this._store[key]; }
  getCapabilities() { return [...this._caps.keys()]; }
  hasCapability(cap) { return this._caps.has(cap); }

  getCapabilityValue(cap) {
    const value = this._caps.get(cap);
    return value === undefined ? null : value;
  }

  async setCapabilityValue(cap, value) {
    if (!this._caps.has(cap)) {
      this.invalidCapabilityWrites.push(cap);
      throw new Error(`Invalid Capability: ${cap}`);
    }
    this._caps.set(cap, value);
  }

  async addCapability(cap) { if (!this._caps.has(cap)) this._caps.set(cap, null); }
  async removeCapability(cap) { this._caps.delete(cap); this._listeners.delete(cap); }

  registerCapabilityListener(cap, fn) {
    if (this._listeners.has(cap)) this.duplicateListeners.push(cap);
    this._listeners.set(cap, fn);
  }

  async triggerCapability(cap, value) {
    const fn = this._listeners.get(cap);
    if (!fn) throw new Error(`No listener registered for ${cap}`);
    return fn(value, {});
  }

  async setAvailable() { this._available = true; this.unavailableReason = null; }
  async setUnavailable(reason) { this._available = false; this.unavailableReason = reason; }
  getAvailable() { return this._available; }

}

class Driver extends Base {

  constructor(opts = {}) {
    super();
    this.homey = opts.homey;
    this._devices = opts.devices || [];
  }

  getDevices() { return this._devices; }

}

class App extends Base {}

const homeyStub = { App, Device, Driver };
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'homey') return homeyStub;
  if (request === 'ws') return FakeWebSocket;
  return originalLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// Fake runtime
// ---------------------------------------------------------------------------

const flowCards = { triggers: new Map(), conditions: new Map(), actions: new Map() };
const firedTriggers = [];

function card(kind, id) {
  const store = flowCards[kind];
  if (!store.has(id)) {
    store.set(id, {
      id,
      runListener: null,
      registerRunListener(fn) { this.runListener = fn; },
      async trigger(device, tokens, state) { firedTriggers.push({ id, tokens, state }); },
    });
  }
  return store.get(id);
}

const drivers = new Map();

const homey = {
  app: null,
  manifest: { version: '1.0.0' },
  clock: { getTimezone: () => 'Europe/Zurich' },
  settings: { set() {}, get() { return null; } },
  __: (key) => key,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
  flow: {
    getDeviceTriggerCard: (id) => card('triggers', id),
    getConditionCard: (id) => card('conditions', id),
    getActionCard: (id) => card('actions', id),
  },
  drivers: {
    getDriver(id) {
      if (!drivers.has(id)) throw new Error(`Invalid Driver: ${id}`);
      return drivers.get(id);
    },
    getDrivers() {
      return Object.fromEntries(drivers);
    },
  },
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------

const TrueNasApp = require(path.join(ROOT, 'app.js'));
const SystemDevice = require(path.join(ROOT, 'drivers/truenas-system/device.js'));
const PoolDevice = require(path.join(ROOT, 'drivers/truenas-pool/device.js'));
const DiskDevice = require(path.join(ROOT, 'drivers/truenas-disk/device.js'));
const ServiceDevice = require(path.join(ROOT, 'drivers/truenas-service/device.js'));
const AppDevice = require(path.join(ROOT, 'drivers/truenas-app/device.js'));
const VmDevice = require(path.join(ROOT, 'drivers/truenas-vm/device.js'));
const PoolDriver = require(path.join(ROOT, 'drivers/truenas-pool/driver.js'));
const TaskDevice = require(path.join(ROOT, 'drivers/truenas-task/device.js'));
const DatasetDevice = require(path.join(ROOT, 'drivers/truenas-dataset/device.js'));
const TaskDriver = require(path.join(ROOT, 'drivers/truenas-task/driver.js'));
const DatasetDriver = require(path.join(ROOT, 'drivers/truenas-dataset/driver.js'));
const manifest = require(path.join(ROOT, 'app.json'));

function capsOf(driverId) {
  return manifest.drivers.find((d) => d.id === driverId).capabilities;
}

function settingsOf(driverId) {
  const out = {};
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.children) walk(node.children);
      else if (node.id) out[node.id] = node.value;
    }
  };
  walk(manifest.drivers.find((d) => d.id === driverId).settings);
  return out;
}

function makeChild(Cls, driverId, entity) {
  const device = buildChild(Cls, driverId, entity);
  const driver = drivers.get(driverId);
  if (driver) {
    driver._devices.push(device);
    device.driver = driver;
  }
  return device;
}

function buildChild(Cls, driverId, entity) {
  const type = driverId.replace('truenas-', '');
  return new Cls({
    homey,
    name: entity,
    data: { id: `truenas-host-id-abc:${type}:${entity}` },
    settings: settingsOf(driverId),
    store: { systemId: 'truenas-host-id-abc', entity },
    capabilities: capsOf(driverId),
  });
}

(async () => {
  note('App');
  const app = new TrueNasApp();
  app.homey = homey;
  homey.app = app;
  await app.onInit();
  check('conditions registered', flowCards.conditions.size, manifest.flow.conditions.length);
  check('actions registered', flowCards.actions.size, manifest.flow.actions.length);

  note('System device');
  const system = new SystemDevice({
    homey,
    name: 'nas',
    data: { id: 'truenas-host-id-abc' },
    settings: {
      ...settingsOf('truenas-system'),
      host: '10.0.0.1', port: 443, api_key: 'k', use_ssl: true, ignore_cert: true,
    },
    capabilities: capsOf('truenas-system'),
  });
  drivers.set('truenas-system', new Driver({ homey, devices: [system] }));
  system.driver = drivers.get('truenas-system');
  for (const id of ['truenas-service', 'truenas-app', 'truenas-vm', 'truenas-pool', 'truenas-disk', 'truenas-task', 'truenas-dataset']) {
    drivers.set(id, new Driver({ homey, devices: [] }));
  }
  await system.onInit();
  await wait(400);

  check('available', system.getAvailable(), true);
  check('no invalid capability writes', system.invalidCapabilityWrites, []);
  check('no duplicate listeners', system.duplicateListeners, []);
  check('cpu usage', system.getCapabilityValue('nas_cpu_usage'), 20);
  check('cpu temperature', system.getCapabilityValue('measure_temperature'), 52);
  check('load1 from system.info', system.getCapabilityValue('nas_load_1'), 1.2);
  check('memory usage %', system.getCapabilityValue('nas_memory_usage'), 25);
  check('uptime', system.getCapabilityValue('nas_uptime'), '1d 1h');
  check('version', system.getCapabilityValue('nas_version'), '25.10.0');
  check('update status', system.getCapabilityValue('nas_update_status'), 'state.update_available (25.10.1)');
  check('alert count', system.getCapabilityValue('nas_alert_count'), 1);
  check('critical alarm set', system.getCapabilityValue('alarm_generic'), true);
  check('alert text stripped of html', system.getCapabilityValue('nas_alert_text'), 'Pool tank is degraded');
  check('net rx Mbit/s', system.getCapabilityValue('nas_net_rx'), 4);
  check('info settings synced', system.getSetting('info_hostname'), 'nas');

  note('Pool device');
  const pool = makeChild(PoolDevice, 'truenas-pool', 'tank');
  await pool.onInit();
  await wait(150);
  check('available', pool.getAvailable(), true);
  check('no invalid writes', pool.invalidCapabilityWrites, []);
  check('no duplicate listeners', pool.duplicateListeners, []);
  check('status', pool.getCapabilityValue('pool_status'), 'Online');
  check('usage %', pool.getCapabilityValue('pool_usage'), 25);
  check('free TB', pool.getCapabilityValue('pool_free'), 6);
  check('alarm clear', pool.getCapabilityValue('alarm_generic'), false);
  check('scrub state', pool.getCapabilityValue('scrub_state'), 'Finished');

  note('Boot pool device');
  const bootPool = makeChild(PoolDevice, 'truenas-pool', 'boot-pool');
  await bootPool.onInit();
  await wait(150);
  check('boot total TB not zero', bootPool.getCapabilityValue('pool_total'), 0.1);
  check('boot usage %', bootPool.getCapabilityValue('pool_usage'), 20);

  note('Disk device');
  const disk = makeChild(DiskDevice, 'truenas-disk', 'ID-SDA');
  await disk.onInit();
  await wait(150);
  check('available', disk.getAvailable(), true);
  check('no invalid writes', disk.invalidCapabilityWrites, []);
  check('temperature', disk.getCapabilityValue('measure_temperature'), 41);
  check('pool resolved', disk.getCapabilityValue('disk_pool'), 'tank');
  check('alarm below threshold', disk.getCapabilityValue('alarm_generic'), false);

  // A spun-down disk reports null. That must not read as 0 °C, which would
  // both look wrong and hide a genuine over-temperature alarm.
  RESPONSES['disk.temperatures'] = { sda: null };
  await system.refreshNow();
  await wait(150);
  check('standby disk keeps last reading, not 0', disk.getCapabilityValue('measure_temperature'), 41);
  RESPONSES['disk.temperatures'] = { sda: 41 };

  note('Service device');
  const service = makeChild(ServiceDevice, 'truenas-service', 'cifs');
  await service.onInit();
  await wait(150);
  check('available', service.getAvailable(), true);
  check('no invalid writes', service.invalidCapabilityWrites, []);
  check('onoff', service.getCapabilityValue('onoff'), true);
  check('state', service.getCapabilityValue('service_state'), 'Running');
  check('autostart', service.getCapabilityValue('service_autostart'), true);

  note('App device');
  const appDev = makeChild(AppDevice, 'truenas-app', 'plex');
  await appDev.onInit();
  await wait(150);
  check('available', appDev.getAvailable(), true);
  check('no invalid writes', appDev.invalidCapabilityWrites, []);
  check('no duplicate listeners', appDev.duplicateListeners, []);
  check('onoff', appDev.getCapabilityValue('onoff'), true);
  check('version', appDev.getCapabilityValue('app_version'), '1.0.0_1.2.3');
  check('catalog update', appDev.getCapabilityValue('app_update_available'), true);
  check('image update', appDev.getCapabilityValue('app_image_update'), true);
  check('containers', appDev.getCapabilityValue('app_containers'), 2);
  check('portal in settings', appDev.getSetting('info_portal'), 'http://nas:32400/web');
  // Redeploy is a force tool, so it stays off until the user asks for it.
  check('redeploy button hidden by default', appDev.hasCapability('app_restart_button'), false);
  check('update button shown by default', appDev.hasCapability('app_upgrade_button'), true);

  note('VM device');
  const vm = makeChild(VmDevice, 'truenas-vm', '7');
  await vm.onInit();
  await wait(150);
  check('available', vm.getAvailable(), true);
  check('no invalid writes', vm.invalidCapabilityWrites, []);
  check('onoff', vm.getCapabilityValue('onoff'), true);
  check('memory MB', vm.getCapabilityValue('vm_memory'), 8192);

  note('Task devices');
  const cloudOk = makeChild(TaskDevice, 'truenas-task', 'cloudsync:3');
  const cloudBad = makeChild(TaskDevice, 'truenas-task', 'cloudsync:4');
  const repl = makeChild(TaskDevice, 'truenas-task', 'replication:9');
  const snap = makeChild(TaskDevice, 'truenas-task', 'snapshot:2');
  for (const d of [cloudOk, cloudBad, repl, snap]) await d.onInit(); // eslint-disable-line no-await-in-loop
  await wait(200);

  check('cloudsync ok state', cloudOk.getCapabilityValue('task_state'), 'Success');
  check('cloudsync ok not alarmed', cloudOk.getCapabilityValue('alarm_generic'), false);
  check('failed task alarms', cloudBad.getCapabilityValue('alarm_generic'), true);
  check('failed task state', cloudBad.getCapabilityValue('task_state'), 'Failed');
  check('running replication progress', repl.getCapabilityValue('task_progress'), 42);
  check('replication state', repl.getCapabilityValue('task_state'), 'Running');
  // Snapshot tasks report under state/state, not job/state.
  check('snapshot task state', snap.getCapabilityValue('task_state'), 'Finished');
  check('last run formatted', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(cloudOk.getCapabilityValue('task_last_run')), true);
  check('run button hidden by default', cloudOk.hasCapability('task_run_button'), false);
  check('no invalid writes', [cloudOk, cloudBad, repl, snap].flatMap((d) => d.invalidCapabilityWrites), []);

  note('Dataset device');
  const dataset = makeChild(DatasetDevice, 'truenas-dataset', 'tank/data');
  await dataset.onInit();
  await wait(200);
  check('available', dataset.getAvailable(), true);
  check('no invalid writes', dataset.invalidCapabilityWrites, []);
  check('usage %', dataset.getCapabilityValue('dataset_usage'), 40);
  check('used GB', dataset.getCapabilityValue('dataset_used'), 200);
  check('free GB', dataset.getCapabilityValue('dataset_free'), 300);
  check('compression ratio', dataset.getCapabilityValue('dataset_compression'), '1.75x');
  check('snapshot button hidden by default', dataset.hasCapability('dataset_snapshot_button'), false);
  check('pool in settings', dataset.getSetting('info_pool'), 'tank');

  note('Task and dataset actions');
  {
    let mark = rpcCalls.length;
    await cloudOk.runTask();
    check('cloudsync run', rpcCalls.slice(mark).map((c) => c.method), ['cloudsync.sync']);

    mark = rpcCalls.length;
    await snap.runTask();
    check('snapshot task run', rpcCalls.slice(mark).map((c) => c.method), ['pool.snapshottask.run']);

    // The replication job is RUNNING, so running it again must be a no-op.
    mark = rpcCalls.length;
    await repl.runTask();
    check('running task not restarted', rpcCalls.slice(mark).map((c) => c.method), []);

    let rejected = null;
    await repl.abortTask().catch((err) => { rejected = err.message; });
    check('only cloudsync can abort', rejected, 'error.abort_unsupported');

    mark = rpcCalls.length;
    const name = await dataset.createSnapshot();
    check('snapshot created', rpcCalls.slice(mark).map((c) => c.method), ['pool.snapshot.create']);
    const params = rpcCalls[rpcCalls.length - 1].params[0];
    check('snapshot targets the dataset', params.dataset, 'tank/data');
    check('snapshot name is timestamped', /^homey-\d{4}-\d{2}-\d{2}-\d{6}$/.test(params.name), true);
    check('name returned as token', name, params.name);
    check('not recursive by default', params.recursive, false);
  }

  note('Task pairing');
  {
    const taskDriver = new TaskDriver({ homey });
    taskDriver.homey = homey;
    const found = await taskDriver.discoverDevices();
    check('all four tasks discovered', found.map((d) => d.name), [
      'Cloud Sync: Backblaze photos',
      'Cloud Sync: Offsite docs',
      'Replication: tank to backup',
      'Snapshot: tank/vm',
    ]);

    const dsDriver = new DatasetDriver({ homey });
    dsDriver.homey = homey;
    const datasets = await dsDriver.discoverDevices();
    // The zvol backs a VM disk and is deliberately left out.
    check('zvol excluded', datasets.map((d) => d.name), ['tank/data']);
  }

  note('Actions produce the right RPC calls');
  const since = () => rpcCalls.length;
  const called = (from) => rpcCalls.slice(from).map((c) => c.method);
  const lastParams = () => rpcCalls[rpcCalls.length - 1].params;

  let mark = since();
  await service.triggerCapability('onoff', false);
  check('service off', called(mark), ['service.control']);
  check('service verb', lastParams()[0], 'STOP');

  await service.triggerCapability('service_restart_button', true);
  check('service restart verb', lastParams()[0], 'RESTART');

  await service.reloadService();
  check('service reload verb', lastParams()[0], 'RELOAD');

  mark = since();
  await vm.setVmState(true);
  check('vm start respects the setting', lastParams()[1], { overcommit: false });
  await vm.setVmState(true, false, true);
  check('flow can allow overcommit', lastParams()[1], { overcommit: true });
  check('start calls vm.start', called(mark), ['vm.start', 'vm.start']);

  mark = since();
  await appDev.triggerCapability('app_upgrade_button', true);
  check('app update uses upgrade', called(mark), ['app.upgrade']);

  await appDev.onSettings({
    newSettings: { show_restart_button: true },
    changedKeys: ['show_restart_button'],
  });
  mark = since();
  await appDev.triggerCapability('app_restart_button', true);
  check('app redeploy once enabled', called(mark), ['app.redeploy']);

  mark = since();
  await vm.triggerCapability('onoff', false);
  check('vm graceful stop', called(mark), ['vm.stop']);

  mark = since();
  await pool.triggerCapability('pool_scrub_button', true);
  check('pool scrub', called(mark), ['pool.scrub.scrub']);

  mark = since();
  await bootPool.triggerCapability('pool_scrub_button', true);
  check('boot pool uses boot.scrub', called(mark), ['boot.scrub']);

  mark = since();
  await system.rebootSystem(0);
  check('reboot', called(mark), ['system.reboot']);

  mark = since();
  await system.installUpdate(false);
  check('install update', called(mark), ['update.run']);
  check('does not reboot by default', lastParams()[0], { reboot: false });

  mark = since();
  await system.installUpdate(true);
  check('install and reboot', lastParams()[0], { reboot: true });
  check('never touches update.update', called(mark).includes('update.update'), false);

  note('System update guards');
  {
    // Nothing pending must not fire an install.
    const withUpdate = RESPONSES['update.status'];
    RESPONSES['update.status'] = {
      code: 'NORMAL',
      status: {
        current_version: { train: 'GOLDEYE', profile: 'GENERAL', matches_profile: true },
        new_version: null,
      },
      error: null,
      update_download_progress: null,
    };
    system.hub.forceUpdateCheck();
    await system.refreshNow();
    await wait(200);

    check('status reads up to date', system.getCapabilityValue('nas_update_status'), 'state.up_to_date');

    const mark = rpcCalls.length;
    await system.installUpdate(false);
    check('no update, no call', rpcCalls.slice(mark).map((c) => c.method), []);

    RESPONSES['update.status'] = withUpdate;
    system.hub.forceUpdateCheck();
    await system.refreshNow();
    await wait(200);
  }

  note('Update button visibility');
  check('hidden by default', system.hasCapability('nas_update_button'), false);
  await system.onSettings({
    newSettings: { show_update_button: true },
    changedKeys: ['show_update_button'],
  });
  check('appears when enabled', system.hasCapability('nas_update_button'), true);
  {
    const mark = rpcCalls.length;
    await system.triggerCapability('nas_update_button', true);
    check('button installs without reboot', rpcCalls[rpcCalls.length - 1].params[0], { reboot: false });
    check('one call only', rpcCalls.slice(mark).map((c) => c.method), ['update.run']);
  }
  check('no duplicate listeners after toggle', system.duplicateListeners, []);

  note('Flow conditions');
  const cond = (id, args) => flowCards.conditions.get(id).runListener(args);
  check('pool_is_healthy', await cond('pool_is_healthy', { device: pool }), true);
  check('service_is_running', await cond('service_is_running', { device: service }), true);
  check('app_update_available', await cond('app_update_available', { device: appDev }), true);
  check('app_image_update_available', await cond('app_image_update_available', { device: appDev }), true);
  check('vm_is_running', await cond('vm_is_running', { device: vm }), true);
  check('system_update_available', await cond('system_update_available', { device: system }), true);
  check('disk_temperature_above 30', await cond('disk_temperature_above', { device: disk, temperature: 30 }), true);
  check('disk_temperature_above 50', await cond('disk_temperature_above', { device: disk, temperature: 50 }), false);
  check('pool_free_space_below 10', await cond('pool_free_space_below', { device: pool, percent: 10 }), false);

  note('Settings toggles (hide and show buttons twice)');
  for (let i = 0; i < 2; i += 1) {
    /* eslint-disable no-await-in-loop */
    await appDev.onSettings({
      newSettings: { show_upgrade_button: false, show_restart_button: false },
      changedKeys: ['show_upgrade_button', 'show_restart_button'],
    });
    await appDev.onSettings({
      newSettings: { show_upgrade_button: true, show_restart_button: true },
      changedKeys: ['show_upgrade_button', 'show_restart_button'],
    });
    /* eslint-enable no-await-in-loop */
  }
  check('no duplicate listeners after toggling', appDev.duplicateListeners, []);
  check('buttons restored', [appDev.hasCapability('app_upgrade_button'), appDev.hasCapability('app_restart_button')], [true, true]);

  note('Pairing discovery');
  const poolDriver = new PoolDriver({ homey });
  poolDriver.homey = homey;
  const discovered = await poolDriver.discoverDevices();
  check('pools discovered', discovered.map((d) => d.name), ['tank', 'boot-pool']);
  check('stable data id', discovered[0].data.id, 'truenas-host-id-abc:pool:tank');
  check('store carries systemId', discovered[0].store.systemId, 'truenas-host-id-abc');

  note('Widget API');
  const widgetApi = require(path.join(ROOT, 'widgets/nas-overview/api.js'));

  const wide = await widgetApi.getOverview({ homey, query: { includeBoot: 'false' } });
  check('ok', wide.ok, true);
  check('name', wide.name, 'nas');
  check('storage excludes boot pool', [wide.storage.used.value, wide.storage.total.value], [2, 8]);
  check('storage percent', wide.storage.percent, 25);
  check('cpu percent', wide.cpu.percent, 20);
  check('memory percent', wide.memory.percent, 25);
  check('network total Mbit', wide.network.totalMbit, 5);
  check('critical alerts', wide.alerts.critical, 1);
  // Rendered via textContent, so the markup must already be gone.
  check('alert text has no markup', wide.alerts.text, 'Pool tank is degraded');
  check('update flagged', wide.updateAvailable, true);
  check('pools listed', wide.pools.map((p) => p.name), ['tank']);
  check('pool unit picked', [wide.pools[0].total.value, wide.pools[0].total.unit], [8, 'TB']);

  const withBoot = await widgetApi.getOverview({ homey, query: { includeBoot: 'true' } });
  check('boot pool included', withBoot.pools.map((p) => p.name), ['tank', 'boot-pool']);
  // A 100 GB boot pool must not collapse to 0.10 TB.
  const bootEntry = withBoot.pools.find((p) => p.isBoot);
  check('boot pool shown in GB', [bootEntry.total.value, bootEntry.total.unit], [100, 'GB']);

  // Resolving through a child device must find the same system.
  const viaChild = await widgetApi.getOverview({
    homey,
    query: { includeBoot: 'false', deviceId: pool.getId() },
  });
  check('resolves via child device', viaChild.name, 'nas');

  // Apps section: state and the catalog-only update flag.
  check('app list', wide.apps.map((a) => a.name), ['plex']);
  check('app running', wide.apps[0].running, true);
  check('app update flag is catalog only', wide.apps[0].update, true);
  check('latest version exposed', wide.apps[0].latestVersion, '2.0.0');

  {
    // A mixed set exercises the filter, the sort and the cut-off.
    const original = RESPONSES['app.query'];
    RESPONSES['app.query'] = [
      { id: 'a', name: 'aaa', state: 'RUNNING', upgrade_available: false, image_updates_available: false, latest_version: null, custom_app: false, migrated: false, human_version: '1', version: '1', portals: {} },
      { id: 'z', name: 'zzz', state: 'RUNNING', upgrade_available: false, image_updates_available: true, latest_version: null, custom_app: false, migrated: false, human_version: '1', version: '1', portals: {} },
      { id: 's', name: 'stopped-one', state: 'STOPPED', upgrade_available: false, image_updates_available: false, latest_version: null, custom_app: false, migrated: false, human_version: '1', version: '1', portals: {} },
      { id: 'c', name: 'crashed-one', state: 'CRASHED', upgrade_available: true, image_updates_available: false, latest_version: '2', custom_app: false, migrated: false, human_version: '1', version: '1', portals: {} },
    ];
    await system.refreshNow();
    await wait(150);

    const mixed = await widgetApi.getOverview({ homey, query: { includeBoot: 'false' } });
    check('all four returned', mixed.apps.length, 4);
    check('running flags', mixed.apps.map((a) => a.running), [true, true, false, false]);
    // zzz has only an image update, so it must NOT be badged; crashed-one has
    // a catalog upgrade and must be.
    check('image-only update not badged', mixed.apps.map((a) => a.update), [false, false, false, true]);
    check('crashed state preserved', mixed.apps.find((a) => a.name === 'crashed-one').state, 'CRASHED');

    RESPONSES['app.query'] = original;
    await system.refreshNow();
    await wait(150);
  }

  note('Widget update button');
  {
    let mark = rpcCalls.length;
    const result = await widgetApi.upgradeApp({ homey, body: { app: 'plex' } });
    check('upgrade issued', rpcCalls.slice(mark).map((c) => c.method), ['app.upgrade']);
    check('targets the app by name', rpcCalls[rpcCalls.length - 1].params[0], 'plex');
    check('asks for the latest version', rpcCalls[rpcCalls.length - 1].params[1], { app_version: 'latest' });
    check('reports success', result, { ok: true, skipped: false });

    // An app with nothing pending must not be touched.
    const noUpdate = RESPONSES['app.query'];
    RESPONSES['app.query'] = [{ ...noUpdate[0], upgrade_available: false, latest_version: null }];
    await system.refreshNow();
    await wait(150);

    mark = rpcCalls.length;
    const skipped = await widgetApi.upgradeApp({ homey, body: { app: 'plex' } });
    check('up-to-date app is skipped', skipped, { ok: true, skipped: true });
    check('no call made', rpcCalls.slice(mark).map((c) => c.method), []);

    RESPONSES['app.query'] = noUpdate;
    await system.refreshNow();
    await wait(150);

    let rejected = null;
    await widgetApi.upgradeApp({ homey, body: { app: 'does-not-exist' } })
      .catch((err) => { rejected = err.message; });
    check('unknown app rejected', rejected, 'error.not_found');
  }

  note('Unreachable NAS marks devices unavailable');
  const brokenSystem = new SystemDevice({
    homey,
    name: 'gone',
    data: { id: 'truenas-gone' },
    settings: {
      ...settingsOf('truenas-system'),
      host: 'unreachable', port: 443, api_key: 'k', use_ssl: true, ignore_cert: true,
    },
    capabilities: capsOf('truenas-system'),
  });
  await brokenSystem.onInit();
  await wait(300);
  check('unavailable on refused connection', brokenSystem.getAvailable(), false);
  await brokenSystem.onDeleted();

  note('Deleting a device mid-update');
  {
    // Homey destroys the Insights logs before calling onDeleted, so any write
    // still in flight fails with "Not Found: LogLocal". Reproduce that by
    // deleting the device while handleData is part way through its writes.
    const victim = makeChild(ServiceDevice, 'truenas-service', 'nfs');
    await victim.onInit();
    await wait(150);

    // Real ordering: Homey drops the device from its driver and destroys the
    // Insights logs FIRST, and only calls onDeleted afterwards. So the writes
    // have to stop without onDeleted having run yet.
    let attemptedWrites = 0;
    victim.setCapabilityValue = async (cap) => {
      attemptedWrites += 1;
      throw new Error(`Not Found: LogLocal with ID homey:device:abc:${cap}`);
    };

    // Stale the cached values so the next run genuinely has something to write;
    // otherwise setCapability skips them as unchanged and the test proves
    // nothing.
    for (const cap of victim.getCapabilities()) victim._caps.set(cap, '__stale__');

    const driverDevices = drivers.get('truenas-service');
    driverDevices._devices = driverDevices._devices.filter((d) => d !== victim);

    let surfaced = null;
    victim.error = (...args) => { surfaced = args.join(' '); };

    // A poll landing after the device was unpaired must write nothing at all.
    victim._service = null;
    victim._onData();
    await wait(150);

    check('no write attempted once unpaired', attemptedWrites, 0);
    check('no error surfaced to the user', surfaced, null);

    await victim.onDeleted();
  }

  note('Teardown');
  for (const device of [pool, bootPool, disk, service, appDev, vm, cloudOk, cloudBad, repl, snap, dataset]) {
    await device.onDeleted(); // eslint-disable-line no-await-in-loop
  }
  await system.onDeleted();
  await wait(150);
  const timers = process._getActiveHandles()
    .filter((h) => h && h.constructor && h.constructor.name === 'Timeout');
  check('no timers left running', timers.length, 0);

  note('Secrets');
  const logged = JSON.stringify(rpcCalls.filter((c) => c.method !== 'auth.login_with_api_key'));
  check('api key never sent outside auth', logged.includes('"k"'), false);

  console.log(failures === 0 ? '\nAll device checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nHarness crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
