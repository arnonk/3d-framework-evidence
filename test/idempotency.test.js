/**
 * test/idempotency.test.js
 *
 * Unit tests for the idempotency store and the idempotent order-placement
 * behaviour in orderService.
 */
'use strict';

const { test, before, afterEach } = require('node:test');
const assert = require('node:assert');

const store = require('../src/services/idempotencyStore');

// ── store unit tests ───────────────────────────────────────────────────────────

test('idempotency store: returns undefined for unknown key', () => {
  store.clear();
  assert.strictEqual(store.get('no-such-key'), undefined);
});

test('idempotency store: returns cached value within TTL', () => {
  store.clear();
  const payload = { order_id: 'ORD-000001', status: 'accepted', fee: 42 };
  store.set('key-1', payload);
  const result = store.get('key-1');
  assert.deepStrictEqual(result, payload);
});

test('idempotency store: different keys are independent', () => {
  store.clear();
  store.set('key-a', { order_id: 'A' });
  store.set('key-b', { order_id: 'B' });
  assert.strictEqual(store.get('key-a').order_id, 'A');
  assert.strictEqual(store.get('key-b').order_id, 'B');
});

test('idempotency store: expired entry returns undefined', async () => {
  // Temporarily shrink the TTL by overriding the config value.
  const config = require('../src/config');
  const original = config.idempotencyTtlMs;
  config.idempotencyTtlMs = 10; // 10 ms

  store.clear();
  store.set('ttl-key', { order_id: 'TTL-TEST' });

  await new Promise(r => setTimeout(r, 20)); // let it expire

  config.idempotencyTtlMs = original;
  // The entry should be gone now (lazy eviction on get).
  assert.strictEqual(store.get('ttl-key'), undefined);
});

test('idempotency store: size tracks entries', () => {
  store.clear();
  assert.strictEqual(store.size(), 0);
  store.set('s1', {});
  store.set('s2', {});
  assert.strictEqual(store.size(), 2);
  store.clear();
  assert.strictEqual(store.size(), 0);
});

// ── placeOrder idempotency integration ────────────────────────────────────────

test('placeOrder: duplicate clientOrderId returns same order', async () => {
  store.clear();
  const orderService = require('../src/services/orderService');

  const body = { symbol: 'AAPL', side: 'buy', qty: 1, price: 100 };
  const key = 'idem-test-' + Date.now();

  const first = await new Promise((resolve, reject) =>
    orderService.placeOrder(body, (e, o) => e ? reject(e) : resolve(o), key)
  );

  const second = await new Promise((resolve, reject) =>
    orderService.placeOrder(body, (e, o) => e ? reject(e) : resolve(o), key)
  );

  // Must be the exact same object (same id, same fee).
  assert.strictEqual(first.id, second.id);
  assert.strictEqual(first.fee, second.fee);
});

test('placeOrder: different clientOrderIds create different orders', async () => {
  store.clear();
  const orderService = require('../src/services/orderService');

  const body = { symbol: 'MSFT', side: 'sell', qty: 2, price: 200 };

  const a = await new Promise((resolve, reject) =>
    orderService.placeOrder(body, (e, o) => e ? reject(e) : resolve(o), 'key-x-' + Date.now())
  );
  const b = await new Promise((resolve, reject) =>
    orderService.placeOrder(body, (e, o) => e ? reject(e) : resolve(o), 'key-y-' + Date.now())
  );

  assert.notStrictEqual(a.id, b.id);
});

test('placeOrder: no clientOrderId always creates a new order', async () => {
  const orderService = require('../src/services/orderService');
  const body = { symbol: 'NVDA', side: 'buy', qty: 3, price: 130 };

  const a = await new Promise((resolve, reject) =>
    orderService.placeOrder(body, (e, o) => e ? reject(e) : resolve(o))
  );
  const b = await new Promise((resolve, reject) =>
    orderService.placeOrder(body, (e, o) => e ? reject(e) : resolve(o))
  );

  assert.notStrictEqual(a.id, b.id);
});
