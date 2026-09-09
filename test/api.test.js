'use strict';

/**
 * Integration tests – backward compatibility of all existing REST endpoints
 * (NFR-5, Risk: partner "hermes").
 *
 * These tests MUST PASS before AND after implementation.
 * They lock the existing API surface and will catch any regression.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { request, startServer, stopServer } = require('./helpers/testUtils');

let server;

before(async () => {
  const app = require('../src/app');
  server = await startServer(app);
});

after(async () => {
  await stopServer(server);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/orders – frozen response shape (partner hermes)', () => {
  test('returns 201 with exactly {order_id, status, fee}', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/api/orders',
      body: { symbol: 'AAPL', side: 'buy', qty: 10, price: 227.5 },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.order_id, 'order_id must be present');
    assert.match(String(res.body.order_id), /^ORD-\d{6}$/);
    assert.equal(res.body.status, 'accepted');
    assert.equal(typeof res.body.fee, 'number');
    // Shape freeze: these three fields must exist
    assert.ok('order_id' in res.body);
    assert.ok('status' in res.body);
    assert.ok('fee' in res.body);
  });

  test('returns 400 for missing symbol', async () => {
    const res = await request(server, {
      method: 'POST', path: '/api/orders',
      body: { side: 'buy', qty: 10, price: 100 },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  test('returns 400 for invalid side', async () => {
    const res = await request(server, {
      method: 'POST', path: '/api/orders',
      body: { symbol: 'AAPL', side: 'LONG', qty: 1, price: 100 },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  test('returns 400 for qty exceeding maxOrderQty', async () => {
    const res = await request(server, {
      method: 'POST', path: '/api/orders',
      body: { symbol: 'AAPL', side: 'buy', qty: 99999, price: 100 },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  test('returns 400 for non-positive price', async () => {
    const res = await request(server, {
      method: 'POST', path: '/api/orders',
      body: { symbol: 'AAPL', side: 'buy', qty: 1, price: -1 },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/orders – existing shape', () => {
  test('returns 200 with { orders: [] }', async () => {
    const res = await request(server, { path: '/api/orders' });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.orders), 'orders must be an array');
  });

  test('each order in list has the required fields', async () => {
    // Place one first so the list is non-empty
    await request(server, {
      method: 'POST', path: '/api/orders',
      body: { symbol: 'AAPL', side: 'buy', qty: 1, price: 227.5 },
    });
    const res = await request(server, { path: '/api/orders' });
    assert.equal(res.status, 200);
    const order = res.body.orders[0];
    assert.ok(order, 'at least one order must exist');
    ['id', 'symbol', 'side', 'qty', 'price', 'status'].forEach((field) => {
      assert.ok(field in order, `field "${field}" missing from order list entry`);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/orders/:id – existing shape', () => {
  test('returns 200 with the order object for a valid id', async () => {
    const placed = await request(server, {
      method: 'POST', path: '/api/orders',
      body: { symbol: 'MSFT', side: 'sell', qty: 5, price: 415 },
    });
    const orderId = placed.body.order_id;

    const res = await request(server, { path: `/api/orders/${orderId}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, orderId);
    assert.equal(res.body.symbol, 'MSFT');
  });

  test('returns 404 for unknown id', async () => {
    const res = await request(server, { path: '/api/orders/ORD-NOPE99' });
    assert.equal(res.status, 404);
    assert.ok(res.body.error, '"error" field must be present in 404 response');
    assert.match(res.body.error, /not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/quote – deprecated but must not be removed (FR-3.1)', () => {
  test('returns 200 with {symbol, price, fee} for known symbol', async () => {
    const res = await request(server, {
      method: 'POST', path: '/api/quote',
      body: { symbol: 'AAPL', qty: 100 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.symbol, 'AAPL');
    assert.ok(typeof res.body.price === 'number');
    assert.ok(typeof res.body.fee === 'number');
  });

  test('returns 500 for unknown symbol', async () => {
    const res = await request(server, {
      method: 'POST', path: '/api/quote',
      body: { symbol: 'UNKNOWN_XYZ', qty: 1 },
    });
    assert.equal(res.status, 500);
    assert.ok(res.body.error);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/health – existing fields plus new fields (FR-4.1)', () => {
  test('returns 200 with status="up" and ts (existing contract)', async () => {
    const res = await request(server, { path: '/api/health' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'up');
    assert.ok(typeof res.body.ts === 'number', 'ts must be a number');
  });

  test('includes circuit_breakers map (FAILS UNTIL T-11 IMPLEMENTED)', async () => {
    const res = await request(server, { path: '/api/health' });
    assert.equal(res.status, 200);
    assert.ok(
      typeof res.body.circuit_breakers === 'object',
      'circuit_breakers must be an object'
    );
    // Each value must be "open" or "closed"
    Object.values(res.body.circuit_breakers).forEach((v) => {
      assert.ok(['open', 'closed'].includes(v),
        `circuit_breakers value must be "open"|"closed", got "${v}"`);
    });
  });

  test('includes ws_connections count (FAILS UNTIL T-11 IMPLEMENTED)', async () => {
    const res = await request(server, { path: '/api/health' });
    assert.equal(res.status, 200);
    assert.ok(
      typeof res.body.ws_connections === 'number',
      'ws_connections must be a number'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('404 for unknown routes', () => {
  test('returns 404 JSON for unknown path', async () => {
    const res = await request(server, { path: '/api/does-not-exist' });
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });
});
