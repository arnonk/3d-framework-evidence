/**
 * test/websocket.test.js
 *
 * Integration tests for the WebSocket real-time feed.
 *
 * Strategy: spin up the full stack (HTTP + WS on an ephemeral port),
 * place orders via HTTP, and assert that the expected WS frames arrive.
 */
'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { WebSocket } = require('ws');

const app = require('../src/app');
const wsService = require('../src/services/wsService');
const book = require('../src/models/orderBook');
const idempotency = require('../src/services/idempotencyStore');
const cb = require('../src/services/circuitBreaker');

// ── server lifecycle ──────────────────────────────────────────────────────────

let server, wsUrl, httpBase;

before(() => new Promise(resolve => {
  server = http.createServer(app);
  wsService.attach(server);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    httpBase = `http://127.0.0.1:${port}`;
    wsUrl    = `ws://127.0.0.1:${port}/ws`;
    resolve();
  });
}));

after(() => new Promise(resolve => {
  server.closeAllConnections();
  server.close(resolve);
}));

beforeEach(() => {
  book.book.orders = [];
  book.book.bySymbol = {};
  idempotency.clear();
  for (const sym of Object.keys(cb._breakers)) cb.reset(sym);
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Open a WS client and resolve with it once the 'welcome' frame arrives. */
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.once('error', reject);
    ws.once('message', raw => {
      const msg = JSON.parse(raw.toString());
      assert.strictEqual(msg.type, 'welcome');
      resolve(ws);
    });
  });
}

/** Collect the next N messages from a connected WS client. */
function collectMessages(ws, n, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const timer = setTimeout(() =>
      reject(new Error(`Timeout: only received ${msgs.length}/${n} messages`)), timeoutMs);
    ws.on('message', raw => {
      msgs.push(JSON.parse(raw.toString()));
      if (msgs.length >= n) {
        clearTimeout(timer);
        resolve(msgs);
      }
    });
  });
}

/** POST an order via HTTP. */
function postOrder(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const { port } = server.address();
    const opts = {
      method: 'POST',
      hostname: '127.0.0.1',
      port,
      path: '/api/orders',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('WebSocket: welcome frame on connect', async () => {
  const ws = await connect();
  ws.close();
});

test('WebSocket: order_book_update fires when order is placed', async () => {
  const ws = await connect();
  const pending = collectMessages(ws, 1);

  await postOrder({ symbol: 'AAPL', side: 'buy', qty: 5, price: 100 });

  const [msg] = await pending;
  ws.close();

  assert.strictEqual(msg.type, 'order_book_update');
  assert.ok(msg.payload.id);
  assert.strictEqual(msg.payload.symbol, 'AAPL');
  assert.strictEqual(msg.payload.side,   'buy');
  assert.strictEqual(msg.payload.qty,    5);
  assert.strictEqual(msg.payload.price,  100);
  assert.strictEqual(msg.payload.status, 'accepted');
  assert.ok(typeof msg.payload.fee === 'number');
});

test('WebSocket: trade_executed fires when order is placed', async () => {
  const ws = await connect();
  // We expect two frames: order_book_update + trade_executed
  const pending = collectMessages(ws, 2);

  await postOrder({ symbol: 'MSFT', side: 'sell', qty: 3, price: 415 });

  const msgs = await pending;
  ws.close();

  const trade = msgs.find(m => m.type === 'trade_executed');
  assert.ok(trade, 'trade_executed frame must arrive');
  assert.strictEqual(trade.payload.symbol, 'MSFT');
  assert.ok(trade.payload.executedAt, 'executedAt timestamp must be present');
});

test('WebSocket: payload fields match HTTP response', async () => {
  const ws = await connect();
  const pending = collectMessages(ws, 1);

  const { body: httpBody } = await postOrder({ symbol: 'NVDA', side: 'buy', qty: 10, price: 131 });
  const [msg] = await pending;
  ws.close();

  assert.strictEqual(msg.payload.id,  httpBody.order_id);
  assert.strictEqual(msg.payload.fee, httpBody.fee);
});

test('WebSocket: multiple clients all receive the broadcast', async () => {
  const [ws1, ws2] = await Promise.all([connect(), connect()]);

  const [p1, p2] = [collectMessages(ws1, 1), collectMessages(ws2, 1)];

  await postOrder({ symbol: 'AAPL', side: 'buy', qty: 1, price: 100 });

  const [[m1], [m2]] = await Promise.all([p1, p2]);
  ws1.close();
  ws2.close();

  assert.strictEqual(m1.type, 'order_book_update');
  assert.strictEqual(m2.type, 'order_book_update');
  assert.strictEqual(m1.payload.id, m2.payload.id);
});

test('WebSocket: channel subscription filters messages', async () => {
  const ws = await connect();

  // Subscribe to trade_executed only.
  ws.send(JSON.stringify({ action: 'subscribe',   channels: ['trade_executed'] }));
  ws.send(JSON.stringify({ action: 'unsubscribe', channels: ['order_book_update'] }));

  const received = [];
  ws.on('message', raw => received.push(JSON.parse(raw.toString())));

  await postOrder({ symbol: 'AAPL', side: 'buy', qty: 2, price: 100 });

  // Give a short window for any stray frames to arrive.
  await new Promise(r => setTimeout(r, 200));
  ws.close();

  const types = received.map(m => m.type);
  assert.ok(types.includes('trade_executed'),    'trade_executed should arrive');
  assert.ok(!types.includes('order_book_update'), 'order_book_update should be filtered');
});

test('WebSocket: idempotent replay does NOT emit duplicate frames', async () => {
  const ws = await connect();
  const key = 'ws-idem-' + Date.now();

  // Place first order – should produce frames.
  const p1 = collectMessages(ws, 2); // order_book_update + trade_executed
  await postOrder({ symbol: 'AAPL', side: 'buy', qty: 1, price: 100 }, { 'x-client-order-id': key });
  await p1;

  // Collect any frames triggered by the replay (there should be none).
  const extra = [];
  ws.on('message', raw => extra.push(JSON.parse(raw.toString())));

  // Replay: same key → cached response, no new order committed.
  await postOrder({ symbol: 'AAPL', side: 'buy', qty: 1, price: 100 }, { 'x-client-order-id': key });

  await new Promise(r => setTimeout(r, 200));
  ws.close();

  assert.strictEqual(extra.length, 0, 'idempotent replay must not emit extra WS frames');
});

test('WebSocket: circuit_breaker frame arrives on volatility spike', async () => {
  const config  = require('../src/config');
  const pricing = require('../src/services/pricingService');
  const sym = 'WS_CB_' + Date.now();

  const orig = { ...config.circuitBreaker };
  config.circuitBreaker.maxMovePct = 0.05;
  config.circuitBreaker.windowMs   = 60_000;

  const ws = await connect();
  const pending = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no circuit_breaker frame')), 2000);
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'circuit_breaker' && m.payload.symbol === sym) {
        clearTimeout(t);
        resolve(m);
      }
    });
  });

  // Trigger the spike; the tick listener in wsService will broadcast.
  pricing.updatePrice(sym, 100);
  pricing.updatePrice(sym, 120); // 20% → trips OPEN, next tick broadcasts

  // Push one more tick to drive the broadcast (the breaker is already OPEN
  // from the second tick; the third tick will find it non-CLOSED and broadcast).
  pricing.updatePrice(sym, 120.1);

  const frame = await pending;
  ws.close();

  Object.assign(config.circuitBreaker, orig);
  cb.reset(sym);

  assert.strictEqual(frame.payload.symbol, sym);
  assert.ok(['OPEN', 'HALF_OPEN'].includes(frame.payload.state));
});
