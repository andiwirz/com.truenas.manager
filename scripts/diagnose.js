'use strict';

/**
 * Connection diagnostics for the TrueNAS Manager app.
 *
 * Performs exactly the handshake the app performs, from a machine on the same
 * network, and reports precisely where it fails.
 *
 *   node scripts/diagnose.js <host> [apiKey]
 *   node scripts/diagnose.js 192.168.1.50
 *   node scripts/diagnose.js 192.168.1.50 1-abcdef...
 *
 * The API key is optional. Without it the endpoint and TLS are still verified;
 * only the login step is skipped. The key is never written anywhere.
 */

const net = require('net');
const dns = require('dns').promises;
const WebSocket = require('ws');

const host = process.argv[2];
const apiKey = process.argv[3] || null;

if (!host) {
  console.error('Usage: node scripts/diagnose.js <host-or-ip> [apiKey]');
  process.exit(1);
}

const CANDIDATES = [
  { scheme: 'wss', port: 443, label: 'HTTPS on 443' },
  { scheme: 'ws', port: 80, label: 'HTTP on 80' },
];

function line(status, message) {
  const mark = { ok: '  ok  ', fail: '  FAIL', info: '  ..  ' }[status] || '      ';
  console.log(`${mark} ${message}`);
}

async function resolveHost() {
  console.log(`\nResolving ${host}`);
  if (net.isIP(host)) {
    line('ok', `${host} is a literal IP address`);
    return true;
  }
  try {
    const { address } = await dns.lookup(host);
    line('ok', `${host} resolves to ${address}`);
    return true;
  } catch (err) {
    line('fail', `${host} does not resolve (${err.code})`);
    line('info', 'Homey may not resolve .local names either. Use the IP address.');
    return false;
  }
}

function tcpProbe(port, timeout = 4000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done('open'));
    socket.once('timeout', () => done('timeout'));
    socket.once('error', (err) => done(err.code || 'error'));
    socket.connect(port, host);
  });
}

function handshake({ scheme, port }) {
  return new Promise((resolve) => {
    const url = `${scheme}://${host}:${port}/api/current`;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.removeAllListeners();
        ws.terminate();
      } catch (_err) { /* already gone */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: 'timed out after 12 s' }), 12000);

    const ws = new WebSocket(url, {
      rejectUnauthorized: false,
      handshakeTimeout: 12000,
      perMessageDeflate: false,
    });

    ws.on('open', () => finish({ ok: true, ws, url }));

    ws.on('unexpected-response', (_req, res) => {
      const location = res.headers && res.headers.location;
      finish({
        ok: false,
        status: res.statusCode,
        location,
        reason: `server answered HTTP ${res.statusCode}`,
      });
    });

    ws.on('error', (err) => finish({ ok: false, reason: err.message }));
  });
}

function rpc(ws, method, params = []) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 100000);
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15000);

    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_err) {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      if (msg.error) {
        reject(new Error(`${msg.error.message}${msg.error.data && msg.error.data.reason ? ` — ${msg.error.data.reason}` : ''}`));
        return;
      }
      resolve(msg.result);
    };

    ws.on('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

(async () => {
  console.log('TrueNAS Manager connection diagnostics');
  console.log('======================================');

  await resolveHost();

  console.log('\nPort reachability');
  for (const { port, label } of CANDIDATES) {
    /* eslint-disable no-await-in-loop */
    const state = await tcpProbe(port);
    if (state === 'open') line('ok', `${label}: TCP port ${port} is open`);
    else line('fail', `${label}: TCP port ${port} — ${state}`);
    /* eslint-enable no-await-in-loop */
  }

  console.log('\nWebSocket handshake on /api/current');
  let session = null;

  for (const candidate of CANDIDATES) {
    /* eslint-disable no-await-in-loop */
    const result = await handshake(candidate);
    if (result.ok) {
      line('ok', `${candidate.label}: connected — use this in the app`);
      if (!session) session = result;
      else result.ws.terminate();
      continue;
    }

    line('fail', `${candidate.label}: ${result.reason}`);

    if (result.status === 301 || result.status === 302 || result.status === 308) {
      line('info', `Redirected to ${result.location || 'HTTPS'} — enable "Use HTTPS" in the device settings.`);
    } else if (result.status === 404) {
      line('info', 'No JSON-RPC endpoint. This TrueNAS is older than 25.04.');
    } else if (/certificate|self.signed/i.test(result.reason || '')) {
      line('info', 'Turn on "Accept self-signed certificate" in the device settings.');
    }
    /* eslint-enable no-await-in-loop */
  }

  if (!session) {
    console.log('\nNo endpoint answered. Check the address and whether the TrueNAS web');
    console.log('interface is reachable from this machine at all.');
    process.exit(1);
  }

  if (!apiKey) {
    console.log('\nEndpoint reachable. Re-run with your API key to test the login:');
    console.log('  node scripts/diagnose.js ' + host + ' <apiKey>');
    session.ws.terminate();
    process.exit(0);
  }

  console.log('\nAuthentication and data');
  try {
    const ok = await rpc(session.ws, 'auth.login_with_api_key', [apiKey]);
    if (ok !== true) {
      line('fail', 'API key rejected by the server');
      line('info', 'Create a fresh key under Credentials, API Keys.');
      session.ws.terminate();
      process.exit(1);
    }
    line('ok', 'API key accepted');
  } catch (err) {
    line('fail', `Login failed: ${err.message}`);
    session.ws.terminate();
    process.exit(1);
  }

  const probes = [
    ['system.info', []],
    ['pool.query', []],
    ['disk.query', [[], { extra: { pools: true } }]],
    ['update.status', []],
    ['reporting.netdata_get_data', [
      [{ name: 'cpu' }, { name: 'memory' }],
      { start: Math.floor(Date.now() / 1000) - 180, end: Math.floor(Date.now() / 1000), aggregate: true },
    ]],
  ];

  for (const [method, params] of probes) {
    /* eslint-disable no-await-in-loop */
    try {
      const result = await rpc(session.ws, method, params);
      if (method === 'system.info') {
        line('ok', `system.info — ${result.hostname}, ${result.version}`);
      } else if (Array.isArray(result)) {
        line('ok', `${method} — ${result.length} entries`);
      } else {
        line('ok', `${method} — answered`);
      }
    } catch (err) {
      line('fail', `${method} — ${err.message}`);
      if (/not authorized|permission/i.test(err.message)) {
        line('info', 'The account behind the API key lacks permission for this call.');
      }
    }
    /* eslint-enable no-await-in-loop */
  }

  console.log('\nDone.');
  session.ws.terminate();
  process.exit(0);
})().catch((err) => {
  console.error('\nDiagnostics crashed:', err.message);
  process.exit(1);
});
