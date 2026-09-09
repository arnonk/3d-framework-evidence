'use strict';
/**
 * test/websocket.test.js
 *
 * Integration tests for real-time WebSocket notifications.
 *
 * Spins up a full http.Server + Express app + wsHub on an ephemeral port,
 * places orders via HTTP, and asserts that:
 *   - Clients receive an 'order_update' event after each placement.
 *   - Clients receive a 'book_snapshot' event with correct side data.
 *   - Per-symbol subscription filtering works.
 *   - Duplicate (idempotent) placements do NOT emit a second order_update.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { WebSocket } = require('ws');

// Reset shared state before spinning up the server.
const idempotency = require('../src/services/idempotency');
const circuitBreaker = require('../src/services/circuitBreaker');
const orderBook = require('../src/models/orderBook');
const wsHub = require('../src/services/wsHub');
const feePool = require('../src/workers/feePool');

let server;
let baseUrl;
let wsUrl;

function collect(ws, type, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${count} '${type}' events (got ${collected.length})`));
    }, timeoutMs);

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        collected.push(msg);
        if (collected.length >= count) {
          clearTimeout(timer);
          resolve(collected);
        }
      }
    });
  });
}

function wsConnect(url, subscription) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => {
      if (subscription) ws.send(JSON.stringify({ subscribe: subscription }));
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

function postOrder(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${baseUrl}/api/orders`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

before(async () => {
  // Reset all shared state.
  idempotency._clear();
  circuitBreaker._reset();
  orderBook.book.orders.length = 0;
  orderBook.book.byId.clear();
  Object.keys(orderBook.book.bySymbol).forEach((k) => delete orderBook.book.bySymbol[k]);

  const app = require('../src/app');
  server = http.createServer(app);
  wsHub.attach(server);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl   = `ws://127.0.0.1:${port}/ws`;
});

after(async () => {
  await feePool.shutdown();
  await new Promise((resolve) => wsHub.close(() => server.close(resolve)));
});

test('order_update event emitted after order placement', async () => {
  const ws = await wsConnect(wsUrl);
  const events = collect(ws, 'order_update', 1);

  await postOrder({ symbol: 'AAPL', side: 'buy', qty: 10, price: 100 });

  const [event] = await events;
  assert.equal(event.type, 'order_update');
  assert.ok(event.data.id, 'event.data should have an order id');
  assert.equal(event.data.symbol, 'AAPL');
  assert.equal(event.data.status, 'accepted');

  ws.close();
});

test('book_snapshot event emitted with correct sides', async () => {
  const ws = await wsConnect(wsUrl);
  const snapshots = collect(ws, 'book_snapshot', 1);

  await postOrder({ symbol: 'MSFT', side: 'sell', qty: 5, price: 200 });

  const [snap] = await snapshots;
  assert.equal(snap.data.symbol, 'MSFT');
  assert.ok(Array.isArray(snap.data.bids));
  assert.ok(Array.isArray(snap.data.asks));
  const ask = snap.data.asks.find((a) => a.price === 200);
  assert.ok(ask, 'sell order should appear in asks');

  ws.close();
});

test('symbol subscription filters events', async () => {
  // Subscribe to TSLA only — should not receive AAPL events.
  const ws = await wsConnect(wsUrl, 'TSLA');

  // Place AAPL order first, then TSLA order.
  // We expect to receive the TSLA order_update but not the AAPL one.
  const received = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'order_update') received.push(msg.data.symbol);
  });

  await postOrder({ symbol: 'AAPL', side: 'buy', qty: 1, price: 100 });
  await postOrder({ symbol: 'TSLA', side: 'buy', qty: 2, price: 100 });

  // Wait briefly for events to arrive.
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(!received.includes('AAPL'), 'AAPL event should not reach TSLA subscriber');
  assert.ok(received.includes('TSLA'), 'TSLA event should reach TSLA subscriber');

  ws.close();
});

test('idempotent order does not emit duplicate order_update', async () => {
  idempotency._clear(); // start fresh for this test
  const ws = await wsConnect(wsUrl);

  const received = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'order_update') received.push(msg);
  });

  const key = 'idem-ws-test-' + Date.now();
  const orderBody = { symbol: 'NVDA', side: 'buy', qty: 3, price: 130 };

  // First placement.
  const r1 = await postOrder(orderBody, { 'idempotency-key': key });
  assert.equal(r1.status, 201);

  // Second placement with same key — should return cached, no second broadcast.
  const r2 = await postOrder(orderBody, { 'idempotency-key': key });
  assert.equal(r2.status, 201);
  assert.equal(r1.body.order_id, r2.body.order_id, 'both calls must return same order_id');

  // Wait for any potential second broadcast.
  await new Promise((r) => setTimeout(r, 300));

  const nvdaEvents = received.filter((e) => e.data.symbol === 'NVDA');
  assert.equal(nvdaEvents.length, 1, 'only one order_update should be broadcast for idempotent calls');

  ws.close();
});
