/**
 * test/orders.test.js
 *
 * Runs with: node --test
 *
 * Coverage:
 *   LEGACY (existing) ──────────────────────────────────────────────────────
 *   1. Order gets sequential ORD-XXXXXX id
 *   2. computeFee uses default bps with legacy rounding
 *   3. pricing returns known / unknown symbol
 *
 *   REST API ────────────────────────────────────────────────────────────────
 *   4. POST /api/orders returns 201 with correct shape
 *   5. POST /api/orders 400 on missing fields
 *   6. GET  /api/orders lists placed orders
 *   7. GET  /api/orders/:id returns single order
 *   8. GET  /api/orders/:id 404 for unknown id
 *   9. POST /api/quote  returns symbol/price/fee (deprecated)
 *  10. POST /api/quote  500 for unknown symbol
 *  11. GET  /api/health returns { status: 'up' }
 *
 *   IDEMPOTENCY ─────────────────────────────────────────────────────────────
 *  12. Same Idempotency-Key produces same order_id (no double-execute)
 *  13. Different keys produce different order ids
 *  14. Concurrent duplicate keys execute only once
 *
 *   CIRCUIT BREAKER ─────────────────────────────────────────────────────────
 *  15. Order within price band is accepted
 *  16. Order outside price band trips the breaker -> 503
 *  17. After reset, next in-band order succeeds
 *  18. GET /api/circuit reflects breaker state
 *  19. POST /api/circuit/:symbol/reset closes the breaker
 *
 *   FEE SERVICE (worker) ────────────────────────────────────────────────────
 *  20. computeFeeAsync returns same value as the synchronous shim
 *  21. Worker pool handles concurrent fee requests
 *
 *   WEBSOCKET ───────────────────────────────────────────────────────────────
 *  22. WS client receives order_ack then order_ready after POST /api/orders
 *  23. WS client receives circuit_open when breaker trips
 *  24. Subscription filter: subscribed symbol receives events, other symbol does not
 *
 *   PERFORMANCE ─────────────────────────────────────────────────────────────
 *  25. order_ack arrives within 50 ms of POST (p99 ack target)
 */
'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocket } = require('ws');

const { Order } = require('../src/models/order');
const orderService = require('../src/services/orderService');
const pricing = require('../src/services/pricingService');
const circuitBreaker = require('../src/services/circuitBreaker');
const idempotency = require('../src/services/idempotency');
const { computeFeeAsync, computeFeeSync } = require('../src/services/feeService');
const wsHub = require('../src/services/wsHub');
const app = require('../src/app');
const book = require('../src/models/orderBook');

// ─── Test server ──────────────────────────────────────────────────────────────

let server;
let serverPort;

before(async () => {
  server = http.createServer(app);
  wsHub.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  serverPort = server.address().port;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  idempotency.clear();
  book.book.orders.length = 0;
  for (const k of Object.keys(book.book.bySymbol)) delete book.book.bySymbol[k];
  for (const sym of ['AAPL','MSFT','TSLA','NVDA','ZZZZ']) {
    circuitBreaker.reset(sym);
  }
});

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function apiReq(method, path, body, headers) {
  headers = headers || {};
  return new Promise(function(resolve, reject) {
    const opts = {
      method: method,
      hostname: '127.0.0.1',
      port: serverPort,
      path: path,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    };
    const r = http.request(opts, function(res) {
      let raw = '';
      res.on('data', function(d) { raw += d; });
      res.on('end', function() {
        let json;
        try { json = JSON.parse(raw); } catch(e) { json = raw; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

// ─── WebSocket helper ─────────────────────────────────────────────────────────

function openWsClient(opts) {
  opts = opts || {};
  return new Promise(function(resolve, reject) {
    const wsUrl = 'ws://127.0.0.1:' + serverPort + '/ws';
    const ws = new WebSocket(wsUrl);
    const messages = [];

    ws.on('open', function() {
      if (opts.subscribe) {
        ws.send(JSON.stringify({ type: 'subscribe', symbols: opts.subscribe }));
      }
      resolve({
        ws: ws,
        messages: messages,
        close: function() {
          return new Promise(function(r) { ws.on('close', r); ws.close(); });
        },
        waitFor: function(predicate, timeoutMs) {
          timeoutMs = timeoutMs || 2000;
          return new Promise(function(res, rej) {
            function check() {
              const found = messages.find(predicate);
              if (found) return res(found);
            }
            ws.on('message', check);
            check();
            setTimeout(function() { rej(new Error('waitFor timeout')); }, timeoutMs);
          });
        },
      });
    });
    ws.on('message', function(raw) {
      try { messages.push(JSON.parse(raw)); } catch(e) {}
    });
    ws.on('error', reject);
  });
}

const GOOD_ORDER = { symbol: 'AAPL', side: 'buy', qty: 100, price: 227.5 };

function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ─── LEGACY ───────────────────────────────────────────────────────────────────

test('legacy: order gets sequential ORD-XXXXXX id', function() {
  const o = new Order({ symbol: 'AAPL', side: 'buy', qty: 10, price: 100 });
  assert.match(o.id, /^ORD-\d{6}$/);
  assert.equal(o.status, 'accepted');
});

test('legacy: computeFee uses default bps with legacy rounding', function() {
  const fee = orderService.computeFee(1000, 100);
  assert.equal(fee, 120);
});

test('legacy: pricing returns known symbol and null for unknown', function() {
  assert.equal(pricing.lastPrice('AAPL'), 227.5);
  assert.equal(pricing.lastPrice('NOPE'), null);
});

// ─── REST API ─────────────────────────────────────────────────────────────────

test('POST /api/orders returns 201 with correct shape', async function() {
  const res = await apiReq('POST', '/api/orders', GOOD_ORDER);
  assert.equal(res.status, 201);
  assert.match(res.body.order_id, /^ORD-\d{6}$/);
  assert.ok('status' in res.body);
  assert.equal(typeof res.body.fee, 'number');
});

test('POST /api/orders 400 on missing symbol', async function() {
  const res = await apiReq('POST', '/api/orders', { side: 'buy', qty: 10, price: 100 });
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test('POST /api/orders 400 on invalid side', async function() {
  const res = await apiReq('POST', '/api/orders', { symbol: 'AAPL', side: 'hold', qty: 10, price: 100 });
  assert.equal(res.status, 400);
});

test('GET /api/orders lists placed orders', async function() {
  await apiReq('POST', '/api/orders', GOOD_ORDER);
  const res = await apiReq('GET', '/api/orders');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.orders));
  assert.ok(res.body.orders.length >= 1);
});

test('GET /api/orders/:id returns single order', async function() {
  const placed = await apiReq('POST', '/api/orders', GOOD_ORDER);
  const id = placed.body.order_id;
  const res = await apiReq('GET', '/api/orders/' + id);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, id);
});

test('GET /api/orders/:id 404 for unknown id', async function() {
  const res = await apiReq('GET', '/api/orders/ORD-999999');
  assert.equal(res.status, 404);
});

test('POST /api/quote returns symbol/price/fee (deprecated endpoint)', async function() {
  const res = await apiReq('POST', '/api/quote', { symbol: 'AAPL', qty: 10 });
  assert.equal(res.status, 200);
  assert.equal(res.body.symbol, 'AAPL');
  assert.equal(typeof res.body.price, 'number');
  assert.equal(typeof res.body.fee, 'number');
});

test('POST /api/quote 500 for unknown symbol', async function() {
  const res = await apiReq('POST', '/api/quote', { symbol: 'ZZZZ', qty: 10 });
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});

test('GET /api/health returns status up', async function() {
  const res = await apiReq('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'up');
});

// ─── IDEMPOTENCY ──────────────────────────────────────────────────────────────

test('same Idempotency-Key returns same order_id without double-execute', async function() {
  const key = 'idem-test-' + Date.now();
  const r1 = await apiReq('POST', '/api/orders', GOOD_ORDER, { 'Idempotency-Key': key });
  const r2 = await apiReq('POST', '/api/orders', GOOD_ORDER, { 'Idempotency-Key': key });
  assert.equal(r1.status, 201);
  assert.equal(r2.body.order_id, r1.body.order_id);
  assert.equal(r2.body.fee, r1.body.fee);
});

test('different Idempotency-Keys produce different order ids', async function() {
  const r1 = await apiReq('POST', '/api/orders', GOOD_ORDER, { 'Idempotency-Key': 'key-A-' + Date.now() });
  const r2 = await apiReq('POST', '/api/orders', GOOD_ORDER, { 'Idempotency-Key': 'key-B-' + Date.now() });
  assert.notEqual(r1.body.order_id, r2.body.order_id);
});

test('concurrent duplicate keys execute only once', async function() {
  const key = 'concurrent-' + Date.now();
  const [r1, r2, r3] = await Promise.all([
    apiReq('POST', '/api/orders', GOOD_ORDER, { 'Idempotency-Key': key }),
    apiReq('POST', '/api/orders', GOOD_ORDER, { 'Idempotency-Key': key }),
    apiReq('POST', '/api/orders', GOOD_ORDER, { 'Idempotency-Key': key }),
  ]);
  assert.equal(r1.body.order_id, r2.body.order_id);
  assert.equal(r1.body.order_id, r3.body.order_id);
});

// ─── CIRCUIT BREAKER ──────────────────────────────────────────────────────────

test('order within price band is accepted', async function() {
  const r1 = await apiReq('POST', '/api/orders', { symbol: 'TSLA', side: 'buy', qty: 1, price: 248.9 });
  assert.equal(r1.status, 201);
  // 260 is ~4.5 % above 248.9 - within the 5 % band
  const r2 = await apiReq('POST', '/api/orders', { symbol: 'TSLA', side: 'sell', qty: 1, price: 260 });
  assert.equal(r2.status, 201);
});

test('order outside price band trips breaker and returns 503', async function() {
  await apiReq('POST', '/api/orders', { symbol: 'NVDA', side: 'buy', qty: 1, price: 100 });
  // +20 % jump -> trips
  const res = await apiReq('POST', '/api/orders', { symbol: 'NVDA', side: 'buy', qty: 1, price: 120 });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'CIRCUIT_OPEN');
});

test('after breaker reset next in-band order succeeds', async function() {
  await apiReq('POST', '/api/orders', { symbol: 'MSFT', side: 'buy', qty: 1, price: 100 });
  await apiReq('POST', '/api/orders', { symbol: 'MSFT', side: 'buy', qty: 1, price: 120 });
  await apiReq('POST', '/api/circuit/MSFT/reset');
  const res = await apiReq('POST', '/api/orders', { symbol: 'MSFT', side: 'buy', qty: 1, price: 100 });
  assert.equal(res.status, 201);
});

test('GET /api/circuit reflects breaker state', async function() {
  await apiReq('POST', '/api/orders', { symbol: 'AAPL', side: 'buy', qty: 1, price: 100 });
  await apiReq('POST', '/api/orders', { symbol: 'AAPL', side: 'buy', qty: 1, price: 200 });
  const res = await apiReq('GET', '/api/circuit');
  assert.equal(res.status, 200);
  assert.equal(res.body.AAPL.state, 'OPEN');
});

test('POST /api/circuit/:symbol/reset closes the breaker', async function() {
  await apiReq('POST', '/api/orders', { symbol: 'AAPL', side: 'buy', qty: 1, price: 100 });
  await apiReq('POST', '/api/orders', { symbol: 'AAPL', side: 'buy', qty: 1, price: 200 });
  const res = await apiReq('POST', '/api/circuit/AAPL/reset');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const st = await apiReq('GET', '/api/circuit');
  const state = st.body.AAPL ? st.body.AAPL.state : 'CLOSED';
  assert.equal(state, 'CLOSED');
});

// ─── FEE SERVICE ─────────────────────────────────────────────────────────────

test('computeFeeAsync returns same value as synchronous shim', async function() {
  const asyncFee = await computeFeeAsync(500, 200);
  const syncFee  = computeFeeSync(500, 200);
  assert.equal(asyncFee, syncFee);
  assert.equal(asyncFee, 120);
});

test('worker pool handles concurrent fee requests correctly', async function() {
  const cases = [
    { qty: 1000, price: 100,  expected: 120  },
    { qty: 500,  price: 200,  expected: 120  },
    { qty: 1,    price: 1,    expected: 0    },
    { qty: 10000,price: 100,  expected: 1200 },
  ];
  const results = await Promise.all(cases.map(function(c) {
    return computeFeeAsync(c.qty, c.price);
  }));
  for (let i = 0; i < cases.length; i++) {
    assert.equal(results[i], cases[i].expected,
      'case ' + i + ': qty=' + cases[i].qty + ' price=' + cases[i].price);
  }
});

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────

test('WS client receives order_ack then order_ready after POST /api/orders', async function() {
  const client = await openWsClient();
  await delay(60); // let circuit_snapshot drain

  await apiReq('POST', '/api/orders', GOOD_ORDER);

  const ack   = await client.waitFor(function(m) { return m.type === 'order_ack'; });
  const ready = await client.waitFor(function(m) { return m.type === 'order_ready'; });

  assert.ok(ack.payload.order_id);
  assert.equal(ack.payload.symbol, 'AAPL');
  assert.ok(ready.payload.order_id);
  assert.equal(typeof ready.payload.fee, 'number');

  await client.close();
});

test('WS client receives circuit_open when breaker trips', async function() {
  const client = await openWsClient();
  await delay(60);

  await apiReq('POST', '/api/orders', { symbol: 'TSLA', side: 'buy', qty: 1, price: 100 });
  await apiReq('POST', '/api/orders', { symbol: 'TSLA', side: 'buy', qty: 1, price: 200 });

  const ev = await client.waitFor(function(m) { return m.type === 'circuit_open'; });
  assert.ok(ev.payload.TSLA);
  assert.equal(ev.payload.TSLA.state, 'OPEN');

  await client.close();
});

test('subscription filter: subscribed symbol receives events, unsubscribed does not', async function() {
  const client = await openWsClient({ subscribe: ['MSFT'] });
  await delay(100);
  client.messages.length = 0;

  // AAPL order - should NOT reach the MSFT-only client
  await apiReq('POST', '/api/orders', { symbol: 'AAPL', side: 'buy', qty: 1, price: 227.5 });
  await delay(300);

  const aaplMsgs = client.messages.filter(function(m) {
    return m.payload && m.payload.symbol === 'AAPL';
  });
  assert.equal(aaplMsgs.length, 0, 'MSFT subscriber must not see AAPL events');

  // MSFT order - SHOULD arrive
  await apiReq('POST', '/api/orders', { symbol: 'MSFT', side: 'buy', qty: 1, price: 415.2 });
  const msftAck = await client.waitFor(function(m) {
    return m.type === 'order_ack' && m.payload && m.payload.symbol === 'MSFT';
  });
  assert.ok(msftAck);

  await client.close();
});

// ─── PERFORMANCE ─────────────────────────────────────────────────────────────

test('order_ack arrives within 50 ms of request start (p99 ack latency target)', async function() {
  const client = await openWsClient();
  await delay(60);

  const t0 = Date.now();
  const [, ack] = await Promise.all([
    apiReq('POST', '/api/orders', GOOD_ORDER),
    client.waitFor(function(m) { return m.type === 'order_ack'; }),
  ]);
  const ackLatencyMs = ack.ts - t0;

  assert.ok(
    ackLatencyMs < 50,
    'order_ack latency ' + ackLatencyMs + ' ms exceeds 50 ms p99 target'
  );

  await client.close();
});
