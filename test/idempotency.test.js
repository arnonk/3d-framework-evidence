'use strict';
/**
 * test/idempotency.test.js
 *
 * Verifies that order placement is idempotent:
 *   - Second call with the same key returns the cached result, not a new order.
 *   - Concurrent duplicate calls both resolve to the same result.
 *   - Calls without a key are never deduplicated.
 *   - A failed first call removes the key so the client can retry.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const idempotency = require('../src/services/idempotency');

beforeEach(() => idempotency._clear());

test('same key returns cached result on second call', async () => {
  let callCount = 0;
  const factory = async () => {
    callCount++;
    return { id: 'ORD-000001', value: callCount };
  };

  const first = await idempotency.withIdempotency('key-A', factory);
  const second = await idempotency.withIdempotency('key-A', factory);

  assert.equal(callCount, 1, 'factory must be called exactly once');
  assert.equal(first.alreadyExisted, false);
  assert.equal(second.alreadyExisted, true);
  assert.deepStrictEqual(first.result, second.result);
});

test('different keys each call the factory', async () => {
  let callCount = 0;
  const factory = async () => ({ id: ++callCount });

  await idempotency.withIdempotency('key-1', factory);
  await idempotency.withIdempotency('key-2', factory);

  assert.equal(callCount, 2);
});

test('null key skips deduplication', async () => {
  let callCount = 0;
  const factory = async () => ({ id: ++callCount });

  const a = await idempotency.withIdempotency(null, factory);
  const b = await idempotency.withIdempotency(null, factory);

  assert.equal(callCount, 2);
  assert.equal(a.alreadyExisted, false);
  assert.equal(b.alreadyExisted, false);
});

test('concurrent duplicates both receive the same result', async () => {
  let callCount = 0;
  const factory = () =>
    new Promise((resolve) => {
      callCount++;
      setImmediate(() => resolve({ id: 'concurrent-result' }));
    });

  const [a, b] = await Promise.all([
    idempotency.withIdempotency('key-concurrent', factory),
    idempotency.withIdempotency('key-concurrent', factory),
  ]);

  assert.equal(callCount, 1, 'factory invoked only once despite concurrency');
  assert.deepStrictEqual(a.result, b.result);
});

test('failed factory removes key so next call retries', async () => {
  let attempt = 0;
  const factory = async () => {
    attempt++;
    if (attempt === 1) throw new Error('transient failure');
    return { id: 'retry-ok' };
  };

  await assert.rejects(
    () => idempotency.withIdempotency('key-retry', factory),
    /transient failure/
  );

  // Key should have been removed; second call should succeed.
  const result = await idempotency.withIdempotency('key-retry', factory);
  assert.equal(result.result.id, 'retry-ok');
  assert.equal(attempt, 2);
});
