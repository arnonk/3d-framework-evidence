'use strict';

/**
 * HTTP + WebSocket test helper.
 *
 * Wraps node:http to fire requests against a live http.Server, and provides
 * a lightweight WebSocket collector that buffers all received messages so
 * tests can await specific event types without fragile setTimeout loops.
 */

const http = require('node:http');
const { WebSocket } = require('ws');

// ─── HTTP helpers ─────────────────────────────────────────────────────────

/**
 * Fire an HTTP request against the given server and resolve with
 * { status, headers, body } where body is already JSON.parsed.
 *
 * @param {http.Server} server
 * @param {{ method?, path, body? }} opts
 * @returns {Promise<{ status: number, headers: object, body: any }>}
 */
function request(server, { method = 'GET', path, body } = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const payload = body != null ? JSON.stringify(body) : undefined;
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── WebSocket collector ──────────────────────────────────────────────────

/**
 * Opens a WebSocket to the running server and collects incoming messages.
 *
 * @example
 * const ws = new WsCollector(server);
 * await ws.connected();
 * await ws.waitFor('book_snapshot');
 * ws.send({ type: 'subscribe', symbol: 'AAPL' });
 * const exec = await ws.waitFor('trade_execution', 2000);
 * ws.close();
 */
class WsCollector {
  constructor(server) {
    const port = server.address().port;
    this._ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this._messages = [];
    this._waiters = []; // { type, resolve, reject, timer }

    this._ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        msg = { type: '__raw__', raw };
      }
      this._messages.push(msg);

      // resolve any waiter that is waiting for this type
      const idx = this._waiters.findIndex(
        (w) => w.type === msg.type || w.type === '*'
      );
      if (idx !== -1) {
        const [w] = this._waiters.splice(idx, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    });

    this._ws.on('error', (err) => {
      this._waiters.forEach((w) => {
        clearTimeout(w.timer);
        w.reject(err);
      });
      this._waiters = [];
    });
  }

  /** Resolves once the WebSocket handshake completes. */
  connected() {
    return new Promise((resolve, reject) => {
      if (this._ws.readyState === WebSocket.OPEN) return resolve();
      this._ws.once('open', resolve);
      this._ws.once('error', reject);
    });
  }

  /**
   * Resolves with the next message of the given type, or rejects after
   * `timeoutMs` milliseconds.
   *
   * @param {string} type   message type (e.g. 'trade_execution'), or '*' for any
   * @param {number} [timeoutMs=3000]
   */
  waitFor(type, timeoutMs = 3000) {
    // Check if we already buffered this type
    const already = this._messages.find(
      (m) => m.type === type || type === '*'
    );
    if (already) {
      this._messages.splice(this._messages.indexOf(already), 1);
      return Promise.resolve(already);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for WS message type="${type}"`)),
        timeoutMs
      );
      this._waiters.push({ type, resolve, reject, timer });
    });
  }

  /**
   * Drain all currently buffered messages matching the given type.
   * Does NOT wait for future messages.
   */
  drain(type) {
    const out = this._messages.filter((m) => m.type === type || type === '*');
    this._messages = this._messages.filter(
      (m) => m.type !== type && type !== '*'
    );
    return out;
  }

  /** Send a JSON message to the server. */
  send(obj) {
    this._ws.send(JSON.stringify(obj));
  }

  /** Close the WebSocket. */
  close() {
    this._ws.close();
  }

  /** All messages received so far (unsorted). */
  get all() {
    return this._messages;
  }
}

// ─── Server lifecycle helpers ─────────────────────────────────────────────

/**
 * Start an http.Server on an ephemeral port and resolve when ready.
 * If wsServer is supplied, it is attached before listen.
 *
 * @param {import('express').Application} app
 * @param {object} [wsServerModule]  module with attach(server)
 * @returns {Promise<http.Server>}
 */
function startServer(app, wsServerModule) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    if (wsServerModule) wsServerModule.attach(server);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

/**
 * Close the server (and optionally the WsCollector) and resolve when done.
 *
 * @param {http.Server} server
 * @param {...WsCollector} collectors
 */
function stopServer(server, ...collectors) {
  collectors.forEach((c) => c.close());
  return new Promise((resolve) => server.close(resolve));
}

module.exports = { request, WsCollector, startServer, stopServer };
