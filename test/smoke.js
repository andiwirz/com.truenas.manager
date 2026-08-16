'use strict';

/**
 * Offline smoke test: drives TrueNasHub with realistic TrueNAS 25.10 payloads
 * (shapes taken from the middleware API models) and checks the parsed output.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const TrueNasHub = require(path.join(ROOT, 'lib', 'TrueNasHub.js'));
const { toGiB, toTiB, get } = require(path.join(ROOT, 'lib', 'util.js'));

const GIB = 1024 ** 3;

const RESPONSES = {
  'system.info': {
    version: 'TrueNAS-SCALE-25.10.0',
    hostname: 'truenas',
    uptime_seconds: 987654,
    system_serial: 'ABC123',
    system_product: 'Custom',
    system_manufacturer: 'ASUS',
    physmem: 64 * GIB,
    cores: 12,
    model: 'Intel(R) Core(TM) i5-12500',
    loadavg: [0.83, 0.61, 0.5],
  },
  'pool.query': [{
    id: 1,
    name: 'tank',
    guid: '123',
    status: 'DEGRADED',
    healthy: false,
    warning: true,
    status_detail: 'One or more devices has experienced an error',
    size: 40 * 1024 * GIB,
    allocated: 30 * 1024 * GIB,
    free: 10 * 1024 * GIB,
    scan: {
      function: 'SCRUB', state: 'SCANNING', percentage: 42.5,
      errors: 0, total_secs_left: 3600,
    },
  }],
  // 25.10 returns a PoolEntry with id and guid excluded — the size fields are
  // right here, not nested under root_dataset like on older releases.
  'boot.get_state': {
    name: 'boot-pool',
    status: 'ONLINE',
    healthy: true,
    warning: false,
    status_detail: null,
    size: 100 * GIB,
    allocated: 10 * GIB,
    free: 90 * GIB,
    scan: { function: 'SCRUB', state: 'FINISHED', percentage: 100, errors: 0 },
  },
  'service.query': [
    { id: 1, service: 'cifs', enable: true, state: 'RUNNING', pids: [123] },
    { id: 2, service: 'nfs', enable: false, state: 'STOPPED', pids: [] },
  ],
  'app.query': [{
    id: 'plex', name: 'plex', state: 'RUNNING',
    upgrade_available: true, latest_version: '1.41.0',
    image_updates_available: true, custom_app: false, migrated: false,
    human_version: '1.40.2_1.2.2', version: '1.2.2',
    portals: { 'Web UI': 'http://192.168.1.50:32400/web' },
    active_workloads: {
      containers: 3,
      used_ports: [], used_host_ips: [], container_details: [],
      volumes: [], images: [], networks: [],
    },
  }, {
    // No portals and no workloads block at all — must not throw.
    id: 'bare', name: 'bare', state: 'STOPPED',
    upgrade_available: false, latest_version: null,
    image_updates_available: false, custom_app: true, migrated: false,
    human_version: '0.1.0', version: '0.1.0',
    portals: {},
  }],
  'vm.query': [{
    id: 1, name: 'Ubuntu', description: 'test vm',
    memory: 4096, vcpus: 2, autostart: true,
    status: { state: 'RUNNING', pid: 999, domain_state: 'RUNNING' },
  }],
  'alert.list': [
    {
      uuid: 'u-info', id: 'a-info', level: 'INFO', klass: 'Test',
      text: 'Just information', formatted: null, dismissed: false,
      datetime: { $date: 1700000000000 },
    },
    {
      uuid: 'u-crit', id: 'a-crit', level: 'CRITICAL', klass: 'PoolStatus',
      text: 'Pool tank is DEGRADED', formatted: 'Pool <b>tank</b> is DEGRADED',
      dismissed: false, datetime: { $date: 1700000100000 },
    },
    {
      uuid: 'u-gone', id: 'a-gone', level: 'ERROR', klass: 'Old',
      text: 'Dismissed one', dismissed: true,
    },
  ],
  'interface.query': [
    {
      id: 'eno1', name: 'eno1', description: '', mtu: 1500,
      state: { link_state: 'LINK_STATE_UP', link_address: 'aa:bb:cc', active_media_type: 'Ethernet' },
    },
    {
      id: 'eno2', name: 'eno2', description: '', mtu: 1500,
      state: { link_state: 'LINK_STATE_DOWN', link_address: 'aa:bb:dd', active_media_type: 'Ethernet' },
    },
  ],
  'disk.query': [
    {
      identifier: '{serial}WD-XYZ', name: 'sda', devname: '/dev/sda',
      serial: 'WD-XYZ', model: 'WDC WD40EFRX', size: 4 * 1024 * GIB,
      type: 'HDD', rotationrate: 5400, bus: 'ATA', pool: 'tank', description: '',
    },
    {
      identifier: '{serial}NVME-1', name: 'nvme0n1', devname: '/dev/nvme0n1',
      serial: 'NVME-1', model: 'Samsung 980', size: 1024 * GIB,
      type: 'SSD', rotationrate: null, bus: 'NVME', pool: null, description: '',
    },
  ],
  'disk.temperatures': { sda: 38, nvme0n1: 52 },
  // 25.10 shape. update.check_available is deliberately absent so the stub
  // reports it as missing, mirroring a Goldeye system.
  'update.status': {
    code: 'NORMAL',
    status: {
      current_version: { train: 'GOLDEYE', profile: 'GENERAL', matches_profile: true },
      new_version: {
        version: '25.10.1',
        manifest: {},
        release_notes: null,
        release_notes_url: 'https://truenas.com/notes',
      },
    },
    error: null,
    update_download_progress: null,
  },
  'reporting.netdata_get_data': [
    { name: 'load', identifier: null, legend: ['shortterm', 'midterm', 'longterm'], aggregations: { mean: { shortterm: 0.83, midterm: 0.61, longterm: 0.5 } } },
    { name: 'cpu', identifier: null, legend: ['cpu'], aggregations: { mean: { cpu: 12.53 } } },
    { name: 'memory', identifier: null, legend: ['available'], aggregations: { mean: { available: 48 * GIB } } },
    { name: 'arcsize', identifier: null, legend: ['arc_size'], aggregations: { mean: { arc_size: 16 * GIB } } },
    { name: 'cputemp', identifier: null, legend: ['0', '1'], aggregations: { mean: { 0: 45.2, 1: 47.8 } } },
    { name: 'interface', identifier: 'eno1', legend: ['received', 'sent'], aggregations: { mean: { received: 8000, sent: 2000 } } },
  ],
};

const calls = [];

function makeStubClient() {
  return {
    connected: true,
    async connect() {},
    disconnect() {},
    on() {},
    removeListener() {},
    async call(method, params) {
      calls.push({ method, params });
      if (!(method in RESPONSES)) {
        const err = new Error(`Method ${method} not found`);
        err.methodMissing = true;
        throw err;
      }
      return RESPONSES[method];
    },
  };
}

// ---------------------------------------------------------------------------

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok    ${label} = ${JSON.stringify(actual)}`);
  }
}

(async () => {
  const hub = new TrueNasHub({
    homey: null,
    systemId: 'test',
    host: '127.0.0.1',
    port: 443,
    apiKey: 'x',
    log: () => {},
    error: () => {},
  });
  hub._client = makeStubClient();

  await hub._poll(true);

  const s = hub.data.system;
  console.log('\nSystem');
  check('hostname', s.hostname, 'truenas');
  check('version', s.version, '25.10.0');
  check('uptime', s.uptime, '11d 10h');
  check('cpuUsage %', s.cpuUsage, 12.5);
  check('cpuTemperature', s.cpuTemperature, 47.8);
  check('load1', s.load1, 0.83);
  check('memoryTotal GB', toGiB(s.memoryTotal), 64);
  check('memoryFree GB', toGiB(s.memoryFree), 48);
  check('memoryUsed GB', toGiB(s.memoryUsed), 16);
  check('memoryUsage %', s.memoryUsage, 25);
  check('arcSize GB', toGiB(s.arcSize), 16);
  check('networkRx Mbit/s', s.networkRx, 8);
  check('networkTx Mbit/s', s.networkTx, 2);

  console.log('\nUpdate (25.10 update.status)');
  check('available', hub.data.update.available, true);
  check('version', hub.data.update.version, '25.10.1');
  check('status', hub.data.update.status, 'AVAILABLE');
  check('release notes url', hub.data.update.releaseNotesUrl, 'https://truenas.com/notes');
  // The missing legacy method must not be treated as an error.
  check('fell back cleanly', hub.available, true);

  console.log('\nPools');
  check('count (incl. boot)', hub.data.pools.length, 2);
  const tank = hub.getPool('tank');
  check('tank status', tank.status, 'DEGRADED');
  check('tank healthy', tank.healthy, false);
  check('tank usage %', tank.usage, 75);
  check('tank free TB', toTiB(tank.free), 10);
  check('tank total TB', toTiB(tank.size), 40);
  check('tank scrub state', tank.scrubState, 'SCANNING');
  check('tank scrub progress', tank.scrubProgress, 42.5);
  const boot = hub.getPool('boot-pool');
  check('boot isBoot', boot.isBoot, true);
  check('boot healthy', boot.healthy, true);
  check('boot usage %', boot.usage, 10);
  // Regression: these came out 0 while the parser still expected root_dataset.
  check('boot total GB', toGiB(boot.size), 100);
  check('boot free GB', toGiB(boot.free), 90);

  console.log('\nDisks');
  check('count', hub.data.disks.length, 2);
  const sda = hub.getDisk('{serial}WD-XYZ');
  check('sda model', sda.model, 'WDC WD40EFRX');
  check('sda pool', sda.pool, 'tank');
  check('sda size TB', toTiB(sda.size), 4);
  check('sda temperature', hub.getDiskTemperature(sda), 38);
  check('nvme temperature', hub.getDiskTemperature(hub.getDisk('{serial}NVME-1')), 52);

  console.log('\nServices');
  check('smb running', hub.getService('cifs').running, true);
  check('smb autostart', hub.getService('cifs').enable, true);
  check('nfs running', hub.getService('nfs').running, false);

  console.log('\nApps');
  check('plex running', hub.getApp('plex').running, true);
  check('plex version', hub.getApp('plex').version, '1.40.2_1.2.2');
  check('plex upgrade', hub.getApp('plex').upgradeAvailable, true);
  check('plex image update', hub.getApp('plex').imageUpdates, true);
  check('plex containers', hub.getApp('plex').containers, 3);
  check('plex portal', hub.getApp('plex').portal, 'http://192.168.1.50:32400/web');
  check('bare containers default', hub.getApp('bare').containers, 0);
  check('bare portal is null', hub.getApp('bare').portal, null);
  check('bare image update', hub.getApp('bare').imageUpdates, false);

  console.log('\nVMs');
  check('vm running', hub.getVm(1).running, true);
  check('vm memory MB', hub.getVm(1).memory, 4096);
  check('vm by string id', hub.getVm('1').name, 'Ubuntu');

  console.log('\nAlerts');
  check('dismissed filtered out', hub.data.alerts.length, 2);
  check('most severe first', hub.data.alerts[0].level, 'CRITICAL');
  check('critical count', hub.criticalAlerts.length, 1);

  console.log('\nInterfaces');
  check('count', hub.data.interfaces.length, 2);
  check('eno1 up', hub.data.interfaces[0].linkState, 'LINK_STATE_UP');

  console.log('\nUpdate API fallback');
  {
    // A 25.04 system: update.status does not exist, update.check_available does.
    const legacy = new TrueNasHub({
      homey: null, systemId: 'legacy', host: '127.0.0.1', port: 443, apiKey: 'x',
      log: () => {}, error: () => {},
    });
    legacy._client = makeStubClient();
    const base = legacy._client.call;
    legacy._client.call = async (method, params) => {
      if (method === 'update.status') {
        const err = new Error('Method not found');
        err.code = -32601;
        err.methodMissing = true;
        throw err;
      }
      if (method === 'update.check_available') {
        return { status: 'AVAILABLE', version: 'TrueNAS-SCALE-25.04.2' };
      }
      return base(method, params);
    };
    await legacy._poll(true);
    check('legacy available', legacy.data.update.available, true);
    check('legacy version', legacy.data.update.version, 'TrueNAS-SCALE-25.04.2');
    check('legacy hub healthy', legacy.available, true);
    legacy.stop();
  }

  console.log('\nUpdate check reporting an error');
  {
    const broken = new TrueNasHub({
      homey: null, systemId: 'broken', host: '127.0.0.1', port: 443, apiKey: 'x',
      log: () => {}, error: () => {},
    });
    broken._client = makeStubClient();
    const base = broken._client.call;
    broken._client.call = async (method, params) => {
      if (method === 'update.status') {
        return {
          code: 'ERROR',
          status: null,
          error: { errname: 'ENONET', reason: 'Could not reach update server' },
          update_download_progress: null,
        };
      }
      return base(method, params);
    };
    await broken._poll(true);
    check('error status', broken.data.update.status, 'ERROR');
    check('not available', broken.data.update.available, false);
    check('error reason kept', broken.data.update.error, 'Could not reach update server');
    // A failed update check must not take the whole device offline.
    check('hub still healthy', broken.available, true);
    broken.stop();
  }

  console.log('\nDisk query options');
  const diskCall = calls.find((c) => c.method === 'disk.query');
  // Without this extra the middleware leaves every disk's pool field null.
  check('requests pool join', get(diskCall, 'params/1/extra/pools'), true);

  console.log('\nReporting request');
  const reporting = calls.find((c) => c.method === 'reporting.netdata_get_data');
  const graphNames = reporting.params[0].map((g) => g.name);
  // `load` is intentionally absent: system.info already supplied loadavg.
  check('graphs requested', graphNames, ['cpu', 'memory', 'arcsize', 'cputemp', 'interface']);
  check('load came from system.info', hub.data.system.load1, 0.83);
  check('only UP interfaces', reporting.params[0].filter((g) => g.name === 'interface').map((g) => g.identifier), ['eno1']);

  console.log('\nAvailability');
  check('hub available', hub.available, true);

  // --- Second run: a graph that the server rejects must not break the cycle ---
  console.log('\nDegraded reporting (cputemp unsupported)');
  const original = RESPONSES['reporting.netdata_get_data'];
  hub._client.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'reporting.netdata_get_data') {
      const names = params[0].map((g) => g.name);
      if (names.includes('cputemp')) throw new Error('[EFAULT] cputemp unavailable');
      return original.filter((g) => g.name !== 'cputemp');
    }
    if (!(method in RESPONSES)) {
      const err = new Error('not found');
      err.methodMissing = true;
      throw err;
    }
    return RESPONSES[method];
  };

  await hub._poll(true);
  check('cputemp marked unavailable', hub.isGraphAvailable('cputemp'), false);
  check('other graphs still fine', hub.isGraphAvailable('cpu'), true);
  check('cpuUsage still parsed', hub.data.system.cpuUsage, 12.5);
  check('hub still available', hub.available, true);

  hub.stop();

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});


