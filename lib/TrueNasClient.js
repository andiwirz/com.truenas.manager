'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');

const DEFAULT_CALL_TIMEOUT = 30000;
const CONNECT_TIMEOUT = 15000;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;

/**
 * Error carrying an i18n key so devices can surface a translated message.
 */
class TrueNasError extends Error {

  constructor(message, i18n = null, code = null) {
    super(message);
    this.name = 'TrueNasError';
    this.i18n = i18n;
    this.code = code;
  }

}

/**
 * Minimal JSON-RPC 2.0 client for the TrueNAS WebSocket API (`/api/current`).
 *
 * This endpoint exists from TrueNAS SCALE 25.04 (Fangtooth) onwards and is the
 * only API in 26.0 and later — the REST API `/api/v2.0` was removed there.
 *
 * All params are positional arrays, matching the middleware's argument models.
 */
class TrueNasClient extends EventEmitter {

  constructor(options = {}) {
    super();

    this.host = options.host;
    this.port = Number(options.port) || 443;
    this.useSsl = options.useSsl !== false;
    this.apiKey = options.apiKey;
    // TrueNAS ships a self-signed certificate, so verification is off by default.
    this.rejectUnauthorized = options.rejectUnauthorized === true;
    this.callTimeout = Number(options.callTimeout) || DEFAULT_CALL_TIMEOUT;

    this._log = options.log || (() => {});
    this._logError = options.error || (() => {});

    this._ws = null;
    this._nextId = 1;
    this._pending = new Map();
    this._connected = false;
    this._connecting = null;
    this._heartbeat = null;
    this._heartbeatTimeout = null;
    this._closing = false;
  }

  get url() {
    const scheme = this.useSsl ? 'wss' : 'ws';
    // Bare IPv6 literals need brackets in a URL.
    const host = this.host.includes(':') && !this.host.startsWith('[')
      ? `[${this.host}]`
      : this.host;
    return `${scheme}://${host}:${this.port}/api/current`;
  }

  get connected() {
    return this._connected;
  }

  /**
   * Opens the socket and authenticates. Concurrent callers share one attempt.
   */
  async connect() {
    if (this._connected) return;
    if (this._connecting) return this._connecting;

    this._connecting = this._doConnect()
      .finally(() => {
        this._connecting = null;
      });

    return this._connecting;
  }

  async _doConnect() {
    this._closing = false;
    await this._openSocket();

    const ok = await this._rawCall('auth.login_with_api_key', [this.apiKey]);
    if (ok !== true) {
      this.disconnect();
      throw new TrueNasError('API key rejected', 'error.auth_failed');
    }

    this._connected = true;
    this._startHeartbeat();
    this.emit('connected');
  }

  _openSocket() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this._teardownSocket();
          reject(err);
        } else {
          resolve();
        }
      };

      const timer = setTimeout(() => {
        done(new TrueNasError('Connection timed out', 'error.timeout'));
      }, CONNECT_TIMEOUT);

      let ws;
      try {
        ws = new WebSocket(this.url, {
          rejectUnauthorized: this.rejectUnauthorized,
          handshakeTimeout: CONNECT_TIMEOUT,
          perMessageDeflate: false,
          maxPayload: 64 * 1024 * 1024,
        });
      } catch (err) {
        done(this._mapConnectError(err));
        return;
      }

      this._ws = ws;

      ws.on('open', () => done());
      ws.on('message', (raw) => this._onMessage(raw));
      ws.on('pong', () => this._onPong());

      ws.on('unexpected-response', (_req, res) => {
        const status = res && res.statusCode;
        const location = (res && res.headers && res.headers.location) || '';

        if (status === 404) {
          done(new TrueNasError(
            `JSON-RPC endpoint not found (HTTP 404) at ${this.url}`,
            'error.no_websocket',
          ));
          return;
        }
        if (status === 401 || status === 403) {
          done(new TrueNasError(`Authentication failed (HTTP ${status})`, 'error.auth_failed'));
          return;
        }
        if (status === 301 || status === 302 || status === 307 || status === 308) {
          // TrueNAS redirects plain HTTP to HTTPS by default, and a WebSocket
          // upgrade cannot follow a redirect.
          done(new TrueNasError(
            `Server redirected to ${location || 'another address'} (HTTP ${status})`,
            'error.redirected',
          ));
          return;
        }
        done(new TrueNasError(
          `Unexpected response from ${this.url} (HTTP ${status})`,
          'error.unreachable',
        ));
      });

      ws.on('error', (err) => done(this._mapConnectError(err)));

      ws.on('close', () => {
        const wasConnected = this._connected;
        this._connected = false;
        this._stopHeartbeat();
        this._rejectAllPending(new TrueNasError('Connection closed', 'error.unreachable'));
        if (wasConnected && !this._closing) this.emit('disconnected');
        done(new TrueNasError('Connection closed during handshake', 'error.unreachable'));
      });
    });
  }

  _mapConnectError(err) {
    const message = String((err && err.message) || err);

    if (/CERT|certificate|self.signed/i.test(message)) {
      return new TrueNasError(message, 'error.cert_rejected');
    }
    if (/ECONNREFUSED/i.test(message)) {
      return new TrueNasError(message, 'error.connection_refused');
    }
    if (/ETIMEDOUT|timeout/i.test(message)) {
      return new TrueNasError(message, 'error.timeout');
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
      // Homey often cannot resolve .local names advertised over mDNS.
      return new TrueNasError(message, 'error.host_not_found');
    }
    if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/i.test(message)) {
      return new TrueNasError(message, 'error.connection_refused');
    }
    if (/wrong version number|EPROTO|SSL routines/i.test(message)) {
      // Talking TLS to a plain HTTP port, or the reverse.
      return new TrueNasError(message, 'error.wrong_protocol');
    }
    return new TrueNasError(`${message} (${this.url})`, 'error.unreachable');
  }

  /**
   * Calls a middleware method. `params` is always a positional array.
   */
  async call(method, params = []) {
    if (!this._connected) await this.connect();
    return this._rawCall(method, params);
  }

  _rawCall(method, params) {
    return new Promise((resolve, reject) => {
      const ws = this._ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new TrueNasError('Not connected', 'error.not_connected'));
        return;
      }

      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new TrueNasError(`Call ${method} timed out`, 'error.timeout'));
      }, this.callTimeout);

      this._pending.set(id, { resolve, reject, timer, method });

      try {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params: Array.isArray(params) ? params : [params],
        }));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new TrueNasError(String(err.message || err), 'error.unreachable'));
      }
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_err) {
      return;
    }

    // Server-pushed events carry no id — we do not subscribe to any.
    if (msg.id === undefined || msg.id === null) return;

    const entry = this._pending.get(msg.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    this._pending.delete(msg.id);

    if (msg.error) {
      entry.reject(this._mapRpcError(msg.error, entry.method));
      return;
    }
    entry.resolve(msg.result);
  }

  _mapRpcError(error, method) {
    const reason = (error.data && error.data.reason) || error.message || 'Unknown error';
    const text = String(reason).trim();
    const err = new TrueNasError(`${method}: ${text}`, null, error.code);

    if (/not authorized|permission|does not have|forbidden/i.test(text)) {
      err.i18n = 'error.permission_denied';
    } else if (error.code === -32601 || /method.*not.*(found|exist)|unknown method/i.test(text)) {
      // -32601 is the JSON-RPC code for "method not found" and does not depend
      // on the server's wording.
      err.methodMissing = true;
    }
    return err;
  }

  _rejectAllPending(err) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeat = setInterval(() => {
      const ws = this._ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      this._heartbeatTimeout = setTimeout(() => {
        this._logError('Heartbeat timed out, closing socket');
        // Tearing down removes the listeners, so the close event will not fire —
        // announce the drop ourselves so the hub can reconnect.
        const wasConnected = this._connected;
        this._connected = false;
        this._stopHeartbeat();
        this._rejectAllPending(new TrueNasError('Connection lost', 'error.unreachable'));
        this._teardownSocket();
        if (wasConnected && !this._closing) this.emit('disconnected');
      }, HEARTBEAT_TIMEOUT);

      try {
        ws.ping();
      } catch (_err) {
        this._onPong();
      }
    }, HEARTBEAT_INTERVAL);
  }

  _onPong() {
    if (this._heartbeatTimeout) {
      clearTimeout(this._heartbeatTimeout);
      this._heartbeatTimeout = null;
    }
  }

  _stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
    this._onPong();
  }

  _teardownSocket() {
    const ws = this._ws;
    this._ws = null;
    if (!ws) return;
    try {
      ws.removeAllListeners();
      ws.terminate();
    } catch (_err) {
      // socket already gone
    }
  }

  disconnect() {
    this._closing = true;
    this._connected = false;
    this._stopHeartbeat();
    this._rejectAllPending(new TrueNasError('Disconnected', 'error.not_connected'));
    this._teardownSocket();
  }

}

module.exports = { TrueNasClient, TrueNasError };
