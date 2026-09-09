/**
 * test/api.test.js
 *
 * HTTP integration tests for all REST endpoints.
 * Spins up the Express app on an ephemeral port; no real network needed.
 */
'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const app = require('../src/app');
const book = require('../src/models/orderBook');
const idempotency = require('../src/services/idempotencyStore');
const cb = require('../src/services/circuitBreaker');

// ── test server lifecycle ─────────────────────────────────────────────────────

let server, baseUrl;

before(() => new Promise(resolve => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    resolve();
  });
}));

after(() => new Promise(resolve => {
  server.closeAllConnections();
  server.close(resolve);
}));

beforeEach(() => {
  // Reset shared state between tests.
  book.book.orders = [];
  book.book.bySymbol = {};
  idempotency.clear();
  // Reset all circuit breakers.
  for (const sym of Object.keys(cb._breakers)) cb.reset(sym);
});

// ── helpers ───────────────────────────────────────────────────────────────────

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const opts = {
      method,
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const POST = (path, body, headers) => request('POST', path, body, headers);
const GET  = (path)               => request('GET',  path);

const VALID_ORDER = { symbol: 'AAPL', side: 'buy', qty: 10, price: 100 };

// ── GET /api/health ───────────────────────────────────────────────────────────

test('GET /api/health returns status up', async () => {
  const { status, body } = await GET('/api/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.status, 'up');
  assert.ok(typeof body.ts === 'number');
  assert.ok(body.circuitBreakers !== undefined);
});

// ── POST /api/orders ──────────────────────────────────────────────────────────

test('POST /api/orders: valid order returns 201 with expected shape', async () => {
  const { status, body } = await POST('/api/orders', VALID_ORDER);
  assert.strictEqual(status, 201);
  assert.match(body.order_id, /^ORD-\d{6}$/);
  assert.strictEqual(body.status, 'accepted');
  assert.ok(typeof body.fee === 'number');
});

test('POST /api/orders: fee value is correct (12 bps, legacy rounding)', async () => {
  // qty=1000, price=100 → 1000*100*12/10000 = 120.0 → floor(120 + 0.4999) = 120
  const { body } = await POST('/api/orders', { symbol: 'AAPL', side: 'buy', qty: 1000, price: 100 });
  assert.strictEqual(body.fee, 120);
});

test('POST /api/orders: missing symbol returns 400', async () => {
  const { status, body } = await POST('/api/orders', { side: 'buy', qty: 10, price: 100 });
  assert.strictEqual(status, 400);
  assert.ok(body.error);
});

test('POST /api/orders: invalid side returns 400', async () => {
  const { status, body } = await POST('/api/orders', { symbol: 'AAPL', side: 'long', qty: 10, price: 100 });
  assert.strictEqual(status, 400);
  assert.ok(body.error);
});

test('POST /api/orders: qty exceeds max returns 400', async () => {
  const { status, body } = await POST('/api/orders', { symbol: 'AAPL', side: 'buy', qty: 99999, price: 100 });
  assert.strictEqual(status, 400);
  assert.ok(body.error);
});

test('POST /api/orders: negative price returns 400', async () => {
  const { status } = await POST('/api/orders', { symbol: 'AAPL', side: 'buy', qty: 1, price: -5 });
  assert.strictEqual(status, 400);
});

// ── idempotency via header ────────────────────────────────────────────────────

test('POST /api/orders: duplicate x-client-order-id returns same order', async () => {
  const key = 'test-idem-' + Date.now();
  const headers = { 'x-client-order-id': key };

  const r1 = await POST('/api/orders', VALID_ORDER, headers);
  const r2 = await POST('/api/orders', VALID_ORDER, headers);

  assert.strictEqual(r1.status, 201);
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r1.body.order_id, r2.body.order_id);
  assert.strictEqual(r1.body.fee,      r2.body.fee);
});

test('POST /api/orders: different keys produce different orders', async () => {
  const r1 = await POST('/api/orders', VALID_ORDER, { 'x-client-order-id': 'k1-' + Date.now() });
  const r2 = await POST('/api/orders', VALID_ORDER, { 'x-client-order-id': 'k2-' + Date.now() });
  assert.notStrictEqual(r1.body.order_id, r2.body.order_id);
});

// ── GET /api/orders ───────────────────────────────────────────────────────────

test('GET /api/orders: returns list with placed orders', async () => {
  await POST('/api/orders', VALID_ORDER);
  await POST('/api/orders', { symbol: 'MSFT', side: 'sell', qty: 5, price: 400 });
  const { status, body } = await GET('/api/orders');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.orders));
  assert.ok(body.orders.length >= 2);
});

test('GET /api/orders: list items have expected fields', async () => {
  await POST('/api/orders', VALID_ORDER);
  const { body } = await GET('/api/orders');
  const o = body.orders[0];
  assert.ok(o.id);
  assert.ok(o.symbol);
  assert.ok(o.side);
  assert.ok(o.qty);
  assert.ok(o.price);
  assert.ok(o.status);
});

// ── GET /api/orders/:id ───────────────────────────────────────────────────────

test('GET /api/orders/:id: returns specific order', async () => {
  const { body: placed } = await POST('/api/orders', VALID_ORDER);
  const { status, body } = await GET('/api/orders/' + placed.order_id);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.id, placed.order_id);
});

test('GET /api/orders/:id: 404 for unknown id', async () => {
  const { status, body } = await GET('/api/orders/ORD-999999');
  assert.strictEqual(status, 404);
  assert.ok(body.error);
});

// ── POST /api/quote (deprecated but kept) ────────────────────────────────────

test('POST /api/quote: returns price and fee for known symbol', async () => {
  const { status, body } = await POST('/api/quote', { symbol: 'AAPL', qty: 10 });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.symbol, 'AAPL');
  assert.ok(typeof body.price === 'number');
  assert.ok(typeof body.fee   === 'number');
});

test('POST /api/quote: returns 500 for unknown symbol', async () => {
  const { status, body } = await POST('/api/quote', { symbol: 'NOPE', qty: 1 });
  assert.strictEqual(status, 500);
  assert.match(body.error, /unknown symbol/);
});

// ── circuit breaker via HTTP ──────────────────────────────────────────────────

test('POST /api/orders: 503 when circuit breaker is OPEN', async () => {
  const config = require('../src/config');
  const pricing = require('../src/services/pricingService');
  const sym = 'AAPLTEST_' + Date.now();

  // Save and override config for fast trip.
  const orig = { ...config.circuitBreaker };
  config.circuitBreaker.maxMovePct = 0.05;
  config.circuitBreaker.windowMs   = 60_000;

  pricing.updatePrice(sym, 100);
  pricing.updatePrice(sym, 115); // 15% move → OPEN

  const { status, body } = await POST('/api/orders',
    { symbol: sym, side: 'buy', qty: 1, price: 115 }
  );

  Object.assign(config.circuitBreaker, orig);
  cb.reset(sym);

  assert.strictEqual(status, 503);
  assert.match(body.error, /Circuit breaker/);
});

// ── admin routes ──────────────────────────────────────────────────────────────

test('GET /api/admin/circuit-breaker: returns snapshot', async () => {
  const { status, body } = await GET('/api/admin/circuit-breaker');
  assert.strictEqual(status, 200);
  assert.ok(body.circuitBreakers !== undefined);
});

test('POST /api/admin/circuit-breaker/:symbol/reset: resets breaker', async () => {
  const pricing = require('../src/services/pricingService');
  const config  = require('../src/config');
  const sym = 'RESET_' + Date.now();

  const orig = { ...config.circuitBreaker };
  config.circuitBreaker.maxMovePct = 0.05;
  config.circuitBreaker.windowMs   = 60_000;

  pricing.updatePrice(sym, 100);
  pricing.updatePrice(sym, 120); // trip it

  assert.ok(cb.check(sym) instanceof Error, 'should be OPEN before reset');

  const { status, body } = await POST(`/api/admin/circuit-breaker/${sym}/reset`);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);

  Object.assign(config.circuitBreaker, orig);
  assert.strictEqual(cb.check(sym), null, 'should be CLOSED after reset');
});

test('POST /api/admin/prices/:symbol: updates price and emits tick', async () => {
  const pricing = require('../src/services/pricingService');
  const sym = 'PRICEPUSH_' + Date.now();

  let ticked = false;
  pricing.emitter.once('tick', ({ symbol, price }) => {
    if (symbol === sym && price === 999.99) ticked = true;
  });

  const { status, body } = await POST(`/api/admin/prices/${sym}`, { price: 999.99 });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.price, 999.99);

  // Give the synchronous emitter time to run (it's sync, but just in case).
  await new Promise(r => setImmediate(r));
  assert.ok(ticked, 'pricing emitter should have fired tick event');
});

test('POST /api/admin/prices/:symbol: rejects invalid price', async () => {
  const { status } = await POST('/api/admin/prices/AAPL', { price: -1 });
  assert.strictEqual(status, 400);
});

// ── 404 fallback ──────────────────────────────────────────────────────────────

test('unknown route returns 404', async () => {
  const { status } = await GET('/api/does-not-exist');
  assert.strictEqual(status, 404);
});
