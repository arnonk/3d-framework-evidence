'use strict';

/**
 * Integration tests – Idempotent order placement (FR-1.2, NFR-3)
 *
 * Tests the full HTTP stack (Express app + orderService + idempotency store).
 * ALL tests that exercise the idempotency_key field WILL FAIL until T-04
 * (idempotencyStore.js) and the corresponding orderService wiring are in place.
 *
 * Tests that cover existing behaviour (no idempotency_key) PASS today.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { request, startServer, stopServer } = require('./helpers/testUtils');

// Lazy-load the app so the require cache is fresh for each test file.
// (node --test runs files in separate processes by default.)
let server;

before(async () => {
  const app = require('../src/app');
  server = await startServer(app);
});

after(async () => {
  await stopServer(server);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function placeOrder(body) {
  return request(server, { method: 'POST', path: '/api/orders', body });
}

function listOrders(symbol) {
  const path = symbol ? `/api/orders?symbol=${symbol}` : '/api/orders';
  return request(server, { path });
}

// A fresh unique suffix so parallel test runs do not collide on idempotency keys.
let keyCounter = 0;
function uniqueKey(prefix = 'idem') {
  return `${prefix}-${Date.now()}-${++keyCounter}`;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('idempotency – existing behaviour without idempotency_key', () => {
  test('POST /api/orders returns 201 with order_id, status, fee', async () => {
    const res = await placeOrder({ symbol: 'AAPL', side: 'buy', qty: 10, price: 227.5 });
    assert.equal(res.status, 201);
    assert.ok(res.body.order_id, 'order_id must be present');
    assert.equal(res.body.status, 'accepted');
    assert.equal(typeof res.body.fee, 'number');
  });

  test('two identical requests without idempotency_key create two distinct orders', async () => {
    const body = { symbol: 'MSFT', side: 'sell', qty: 5, price: 415 };
    const r1 = await placeOrder(body);
    const r2 = await placeOrder(body);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.notEqual(r1.body.order_id, r2.body.order_id,
      'non-idempotent calls must produce distinct order IDs');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('idempotency – with idempotency_key (FAILS UNTIL T-04 IMPLEMENTED)', () => {
  test('two requests with the same idempotency_key return the same order_id', async () => {
    const key = uniqueKey();
    const body = { symbol: 'AAPL', side: 'buy', qty: 20, price: 227.5, idempotency_key: key };

    const r1 = await placeOrder(body);
    assert.equal(r1.status, 201, `first call: expected 201, got ${r1.status}`);

    const r2 = await placeOrder(body);
    // Spec says duplicate returns HTTP 200 (original) or 201 – the response body must match.
    assert.ok([200, 201].includes(r2.status),
      `second call: expected 200 or 201, got ${r2.status}`);
    assert.equal(r2.body.order_id, r1.body.order_id,
      'duplicate call must return the same order_id');
    assert.equal(r2.body.status, r1.body.status);
    assert.equal(r2.body.fee, r1.body.fee);
  });

  test('duplicate idempotent call does NOT create a second order', async () => {
    const key = uniqueKey('no-dup');
    const body = { symbol: 'NVDA', side: 'buy', qty: 3, price: 131, idempotency_key: key };

    const before = (await listOrders('NVDA')).body.orders ?? [];
    await placeOrder(body); // first
    await placeOrder(body); // duplicate

    const after = (await listOrders('NVDA')).body.orders ?? [];
    // Exactly one NEW order should have been added.
    assert.equal(
      after.length - before.length, 1,
      `duplicate call must not create a second order (before=${before.length}, after=${after.length})`
    );
  });

  test('different idempotency_key on same payload creates two distinct orders', async () => {
    const key1 = uniqueKey('k1');
    const key2 = uniqueKey('k2');
    const base = { symbol: 'TSLA', side: 'sell', qty: 1, price: 248.9 };

    const r1 = await placeOrder({ ...base, idempotency_key: key1 });
    const r2 = await placeOrder({ ...base, idempotency_key: key2 });

    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.notEqual(r1.body.order_id, r2.body.order_id,
      'different keys must produce different orders');
  });

  test('idempotency_key longer than 128 chars is rejected with 400', async () => {
    const longKey = 'x'.repeat(129);
    const res = await placeOrder({
      symbol: 'AAPL', side: 'buy', qty: 1, price: 200,
      idempotency_key: longKey,
    });
    assert.equal(res.status, 400, `expected 400 for overlong key, got ${res.status}`);
    assert.ok(res.body.error, 'error field must be present');
  });

  test('response body shape is frozen: exactly {order_id, status, fee} (partner hermes)', async () => {
    // NFR-5 / risk constraint: no extra top-level fields that could confuse hermes.
    const key = uniqueKey('hermes');
    const res = await placeOrder({
      symbol: 'AAPL', side: 'buy', qty: 1, price: 200,
      idempotency_key: key,
    });
    assert.equal(res.status, 201);
    const keys = Object.keys(res.body);
    // Must contain exactly these three:
    assert.ok(keys.includes('order_id'), 'order_id missing');
    assert.ok(keys.includes('status'), 'status missing');
    assert.ok(keys.includes('fee'), 'fee missing');
    // Must NOT contain additional fields that break positional parsers:
    const extra = keys.filter((k) => !['order_id', 'status', 'fee'].includes(k));
    assert.equal(extra.length, 0, `unexpected extra fields in response: ${extra}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('idempotency – store TTL and GC (NFR-3, risk constraint)', () => {
  test('idempotencyStore module is exported with get/set/sweep', () => {
    // [FAILS UNTIL T-04 IMPLEMENTED]
    let store;
    try {
      store = require('../src/services/idempotencyStore');
    } catch {
      assert.fail('idempotencyStore module does not exist yet (T-04 pending)');
    }
    assert.equal(typeof store.get, 'function', 'store.get must be a function');
    assert.equal(typeof store.set, 'function', 'store.set must be a function');
    assert.equal(typeof store.sweep, 'function', 'store.sweep must be a function');
  });

  test('sweep() removes entries older than 24 hours', () => {
    // [FAILS UNTIL T-04 IMPLEMENTED]
    let store;
    try {
      store = require('../src/services/idempotencyStore');
    } catch {
      assert.fail('idempotencyStore not found');
    }
    const key = 'sweep-test-' + Date.now();
    store.set(key, { order_id: 'ORD-SWEEP', status: 'accepted', fee: 1 });
    assert.ok(store.get(key), 'entry must be present before sweep');

    // Force expiry via test helper
    if (typeof store._forceExpire === 'function') {
      store._forceExpire(key);
      store.sweep();
      assert.equal(store.get(key), undefined, 'entry must be evicted after sweep');
    } else {
      assert.fail('store._forceExpire not implemented (needed for TTL tests)');
    }
  });

  test('entry within TTL survives sweep()', () => {
    // [FAILS UNTIL T-04 IMPLEMENTED]
    let store;
    try {
      store = require('../src/services/idempotencyStore');
    } catch {
      assert.fail('idempotencyStore not found');
    }
    const key = 'alive-' + Date.now();
    store.set(key, { order_id: 'ORD-ALIVE', status: 'accepted', fee: 0 });
    store.sweep(); // should not evict a fresh entry
    assert.ok(store.get(key), 'fresh entry must survive sweep()');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('idempotency – GET /api/orders symbol filter (FR-2.3)', () => {
  test('?symbol= filter returns only matching orders', async () => {
    // Place one AAPL and one TSLA order
    await placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, price: 227 });
    await placeOrder({ symbol: 'TSLA', side: 'sell', qty: 1, price: 248 });

    const res = await listOrders('AAPL');
    assert.equal(res.status, 200);
    const orders = res.body.orders;
    assert.ok(Array.isArray(orders));
    orders.forEach((o) =>
      assert.equal(o.symbol, 'AAPL',
        `unexpected symbol in filtered list: ${o.symbol}`)
    );
  });

  test('GET /api/orders without filter returns all orders', async () => {
    const res = await listOrders();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.orders));
  });
});
