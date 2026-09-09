'use strict';
/**
 * test/feePool.test.js
 *
 * Verifies that the worker-thread fee pool:
 *   - Produces bit-identical results to the original synchronous computeFee
 *   - Handles concurrent requests correctly
 *   - Does not block the event loop during computation
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const feePool = require('../src/workers/feePool');
const { computeFee: syncComputeFee } = require('../src/services/orderService');

after(async () => {
  await feePool.shutdown();
});

test('worker fee matches synchronous fee formula', async () => {
  const cases = [
    { qty: 1000, price: 100 },   // expected: 120
    { qty: 500,  price: 227.5 }, // expected: floor(500*227.5*12/10000 + 0.4999) = 136
    { qty: 1,    price: 1 },     // expected: floor(1*1*12/10000 + 0.4999) = 0
    { qty: 10000, price: 415.2 }, // large order
  ];

  for (const { qty, price } of cases) {
    const workerFee = await feePool.computeFee(qty, price);
    const syncFee   = syncComputeFee(qty, price);
    assert.equal(
      workerFee,
      syncFee,
      `fee mismatch for qty=${qty} price=${price}: worker=${workerFee} sync=${syncFee}`
    );
  }
});

test('event loop stays responsive during fee computation', async () => {
  // Warm up the pool so worker-thread startup latency does not skew this
  // measurement (startup is a one-time cost, not a per-request cost).
  await feePool.computeFee(1, 1);

  // Fire several fee computations concurrently; each burns ~30 ms in the
  // worker thread.  setImmediate should still resolve almost instantly on
  // the main thread, proving the event loop is not blocked by the spin.
  const feePromises = Array.from({ length: 4 }, () =>
    feePool.computeFee(1000, 100)
  );

  const t0 = Date.now();
  let tickElapsed;
  await new Promise((resolve) => {
    setImmediate(() => {
      tickElapsed = Date.now() - t0;
      resolve();
    });
  });

  assert.ok(
    tickElapsed < 10,
    `event loop was blocked: setImmediate took ${tickElapsed} ms after warm pool`
  );

  // Verify correctness while we're here.
  const fees = await Promise.all(feePromises);
  fees.forEach((fee) => assert.equal(fee, 120));
});

test('concurrent requests all resolve correctly', async () => {
  const N = 16;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => feePool.computeFee(i + 1, 100))
  );
  results.forEach((fee, i) => {
    const expected = syncComputeFee(i + 1, 100);
    assert.equal(fee, expected, `index ${i}: got ${fee} expected ${expected}`);
  });
});
