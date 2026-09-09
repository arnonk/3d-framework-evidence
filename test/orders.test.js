const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../src/app');
const { Order, resetIdSequence } = require('../src/models/order');
const { engine } = require('../src/models/orderBook');
const orderService = require('../src/services/orderService');
const pricing = require('../src/services/pricingService');
const { circuitBreakerService } = require('../src/services/circuitBreakerService');
const { idempotencyService } = require('../src/services/idempotencyService');

let server;
let baseUrl;

before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => {
    server.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  engine.clear();
  circuitBreakerService.clear();
  idempotencyService.clear();
  pricing.resetPrices();
  resetIdSequence(1);
});

// Original legacy test cases preserved
test('order gets sequential id', () => {
  const o = new Order({ symbol: 'AAPL', side: 'buy', qty: 10, price: 100 });
  assert.match(o.id, /^ORD-\d{6}$/);
  assert.equal(o.status, 'accepted');
});

test('fee uses default bps with legacy rounding', () => {
  const fee = orderService.computeFee(1000, 100);
  assert.equal(fee, 120); // 1000*100*12/10000 = 120
});

test('pricing returns known symbol', () => {
  assert.equal(pricing.lastPrice('AAPL'), 227.5);
  assert.equal(pricing.lastPrice('NOPE'), null);
});

// REST API backward compatibility integration tests
test('REST POST /api/orders places order with exact response shape', async () => {
  const res = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'AAPL', side: 'buy', qty: 100, price: 227.5 }),
  });

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.order_id, 'ORD-000001');
  assert.equal(data.status, 'accepted');
  assert.equal(data.fee, 27); // 100 * 227.5 * 12 / 10000 = 27.3 -> 27
});

test('REST POST /api/orders validation failure returns status 400', async () => {
  const res = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'AAPL', side: 'invalid_side', qty: 100, price: 227.5 }),
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /side must be buy\|sell/i);
});

test('REST POST /api/orders price band violation returns status 422', async () => {
  // Reference price for AAPL is 227.5. Band ±5% is [216.125, 238.875]. Price 300 is outside.
  const res = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'AAPL', side: 'buy', qty: 10, price: 300.0 }),
  });

  assert.equal(res.status, 422);
  const data = await res.json();
  assert.match(data.error, /outside price band/i);
});

test('REST POST /api/orders idempotency header returns identical cached 201 response', async () => {
  const headers = {
    'Content-Type': 'application/json',
    'Idempotency-Key': 'retry-token-42',
  };
  const body = JSON.stringify({ symbol: 'AAPL', side: 'buy', qty: 50, price: 227.5 });

  const res1 = await fetch(`${baseUrl}/api/orders`, { method: 'POST', headers, body });
  assert.equal(res1.status, 201);
  const data1 = await res1.json();

  // Retry with same idempotency key
  const res2 = await fetch(`${baseUrl}/api/orders`, { method: 'POST', headers, body });
  assert.equal(res2.status, 201);
  const data2 = await res2.json();

  assert.equal(data1.order_id, data2.order_id);
  assert.equal(data1.fee, data2.fee);
  assert.equal(data1.status, data2.status);

  // Check order book has only 1 order
  const listRes = await fetch(`${baseUrl}/api/orders`);
  const listData = await listRes.json();
  assert.equal(listData.orders.length, 1);
});

test('REST GET /api/orders and GET /api/orders/:id', async () => {
  await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'MSFT', side: 'buy', qty: 10, price: 415.2 }),
  });

  const listRes = await fetch(`${baseUrl}/api/orders`);
  const list = await listRes.json();
  assert.equal(list.orders.length, 1);
  assert.equal(list.orders[0].symbol, 'MSFT');

  const orderId = list.orders[0].id;
  const singleRes = await fetch(`${baseUrl}/api/orders/${orderId}`);
  const single = await singleRes.json();
  assert.equal(single.id, orderId);
  assert.equal(single.symbol, 'MSFT');

  const notFoundRes = await fetch(`${baseUrl}/api/orders/NONEXISTENT`);
  assert.equal(notFoundRes.status, 404);
});

test('REST POST /api/quote deprecated endpoint returns quote and fee', async () => {
  const res = await fetch(`${baseUrl}/api/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'AAPL', qty: 10 }),
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.symbol, 'AAPL');
  assert.equal(data.price, 227.5);
  assert.equal(data.fee, 3); // 10 * 227.5 * 12 / 10000 = 2.73 -> 3
});

test('REST GET /api/health returns health status', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'up');
  assert.ok(typeof data.ts === 'number');
});

test('REST GET /api/book/:symbol returns L2 depth', async () => {
  await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'AAPL', side: 'buy', qty: 50, price: 227.0 }),
  });

  const res = await fetch(`${baseUrl}/api/book/AAPL`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.symbol, 'AAPL');
  assert.deepEqual(data.bids, [[227.0, 50]]);
});
