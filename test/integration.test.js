'use strict';
/**
 * test/integration.test.js
 *
 * Full-stack integration tests covering:
 *   1. Existing REST API backward compatibility (frozen response shapes)
 *   2. Deprecated POST /api/quote still works for partner "hermes"
 *   3. GET /api/orders and GET /api/orders/:id
 *   4. Validation errors return 400
 *   5. Circuit breaker returns 503 with retriableAfterMs
 *   6. Idempotent placement via HTTP Idempotency-Key header
 *   7. p99 acknowledgement latency < 50 ms over 20 sequential orders
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const idempotency = require('../src/services/idempotency');
const circuitBreaker = require('../src/services/circuitBreaker');
const orderBook = require('../src/models/orderBook');
const wsHub = require('../src/services/wsHub');
const feePool = require('../src/workers/feePool');

let server;
let baseUrl;

// ── Helpers ─────────────────────────────────────────────────────────────────

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };
    const req = http.request(`${baseUrl}${path}`, opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(buf), headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, body: buf, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const post = (path, body, headers) => request('POST', path, body, headers);
const get  = (path)               => request('GET',  path);

// ── Lifecycle ────────────────────────────────────────────────────────────────

before(async () => {
  // Wipe all shared in-memory state so tests are isolated.
  idempotency._clear();
  circuitBreaker._reset();
  orderBook.book.orders.length = 0;
  orderBook.book.byId.clear();
  Object.keys(orderBook.book.bySymbol).forEach((k) => delete orderBook.book.bySymbol[k]);

  const app = require('../src/app');
  server = http.createServer(app);
  // WS hub is optional for integration tests; attach silently so health works.
  wsHub.attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await feePool.shutdown();
  await new Promise((r) => wsHub.close(() => server.close(r)));
});

// ── Tests ────────────────────────────────────────────────────────────────────

test('POST /api/orders returns frozen shape { order_id, status, fee }', async () => {
  const res = await post('/api/orders', { symbol: 'AAPL', side: 'buy', qty: 100, price: 200 });
  assert.equal(res.status, 201);
  assert.ok(typeof res.body.order_id === 'string', 'order_id must be a string');
  assert.ok(res.body.order_id.startsWith('ORD-'), 'order_id must start with ORD-');
  assert.equal(res.body.status, 'accepted');
  assert.ok(typeof res.body.fee === 'number', 'fee must be a number');
  // Verify fee amount: 100 * 200 * 12 / 10000 = 24
  assert.equal(res.body.fee, 24);
  // Frozen shape: only these three keys should be present.
  const keys = Object.keys(res.body);
  assert.deepStrictEqual(keys.sort(), ['fee', 'order_id', 'status']);
});

test('POST /api/quote (deprecated) returns { symbol, price, fee }', async () => {
  const res = await post('/api/quote', { symbol: 'AAPL', qty: 10 });
  assert.equal(res.status, 200);
  assert.equal(res.body.symbol, 'AAPL');
  assert.ok(typeof res.body.price === 'number');
  assert.ok(typeof res.body.fee === 'number');
});

test('POST /api/quote returns 500 for unknown symbol', async () => {
  const res = await post('/api/quote', { symbol: 'UNKNOWN' });
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});

test('GET /api/orders returns list of placed orders', async () => {
  const res = await get('/api/orders');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.orders));
  // Each entry must include required fields.
  res.body.orders.forEach((o) => {
    assert.ok(o.id);
    assert.ok(o.symbol);
    assert.ok(o.side === 'buy' || o.side === 'sell');
    assert.ok(o.qty > 0);
    assert.ok(o.price > 0);
    assert.ok(o.status);
  });
});

test('GET /api/orders/:id returns a single order', async () => {
  const placed = await post('/api/orders', { symbol: 'MSFT', side: 'sell', qty: 5, price: 400 });
  const id = placed.body.order_id;
  const res = await get(`/api/orders/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, id);
  assert.equal(res.body.symbol, 'MSFT');
});

test('GET /api/orders/:id returns 404 for unknown id', async () => {
  const res = await get('/api/orders/ORD-999999');
  assert.equal(res.status, 404);
  assert.ok(res.body.error);
});

test('POST /api/orders returns 400 on validation failure', async () => {
  const cases = [
    { desc: 'missing symbol', body: { side: 'buy', qty: 1, price: 100 } },
    { desc: 'bad side',       body: { symbol: 'AAPL', side: 'hold', qty: 1, price: 100 } },
    { desc: 'zero qty',       body: { symbol: 'AAPL', side: 'buy', qty: 0, price: 100 } },
    { desc: 'negative price', body: { symbol: 'AAPL', side: 'buy', qty: 1, price: -1 } },
    { desc: 'qty over max',   body: { symbol: 'AAPL', side: 'buy', qty: 99999, price: 1 } },
  ];
  for (const { desc, body } of cases) {
    const res = await post('/api/orders', body);
    assert.equal(res.status, 400, `${desc}: expected 400 got ${res.status}`);
    assert.ok(res.body.error, `${desc}: expected error message`);
  }
});

test('circuit breaker returns 503 with retriableAfterMs on price spike', async () => {
  // Anchor the price at 100.
  await post('/api/orders', { symbol: 'NVDA', side: 'buy', qty: 1, price: 100 });

  // Now attempt an order with a 20% spike (well above the 5% band).
  const res = await post('/api/orders', { symbol: 'NVDA', side: 'buy', qty: 1, price: 120 });
  assert.equal(res.status, 503, `expected 503, got ${res.status}`);
  assert.match(res.body.error, /circuit open/);
  assert.ok(typeof res.body.retriableAfterMs === 'number');
  assert.ok(res.body.retriableAfterMs > 0);
});

test('idempotency-key header prevents duplicate order creation', async () => {
  idempotency._clear();
  const key = 'integ-idem-' + Date.now();
  const orderBody = { symbol: 'TSLA', side: 'buy', qty: 2, price: 100 };

  const r1 = await post('/api/orders', orderBody, { 'idempotency-key': key });
  const r2 = await post('/api/orders', orderBody, { 'idempotency-key': key });

  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(r1.body.order_id, r2.body.order_id, 'both responses must share the same order_id');
  assert.equal(r1.body.fee, r2.body.fee);

  // Only one order should exist in the book with this id.
  const listRes = await get('/api/orders');
  const matching = listRes.body.orders.filter((o) => o.id === r1.body.order_id);
  assert.equal(matching.length, 1, 'only one order in book despite two HTTP calls');
});

test('GET /api/health returns up status with circuit breaker snapshot', async () => {
  const res = await get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'up');
  assert.ok(typeof res.body.ts === 'number');
  assert.ok(typeof res.body.wsClients === 'number');
  assert.ok(typeof res.body.circuitBreakers === 'object');
});

test('p99 order acknowledgement latency is under 50 ms', async () => {
  // Reset the circuit breaker so price deviations from previous tests don't interfere.
  circuitBreaker._reset();

  const N = 20;
  const latencies = [];

  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const res = await post('/api/orders', {
      symbol: 'AAPL',
      side: 'buy',
      qty: 1,
      price: 100, // fixed price so circuit breaker never trips
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 201, `request ${i} failed with status ${res.status}`);
    latencies.push(elapsed);
    // Small jitter reset between orders so the CB doesn't trip.
    circuitBreaker._reset();
  }

  latencies.sort((a, b) => a - b);
  const p99 = latencies[Math.ceil(N * 0.99) - 1];
  const p50 = latencies[Math.floor(N * 0.50)];

  console.log(`  Latency p50=${p50}ms  p99=${p99}ms  (N=${N})`);
  assert.ok(
    p99 < 50,
    `p99 latency ${p99} ms exceeds 50 ms target. Full distribution: ${JSON.stringify(latencies)}`
  );
});
