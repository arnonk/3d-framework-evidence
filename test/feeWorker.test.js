/**
 * test/feeWorker.test.js
 *
 * Verifies that the async fee computation (worker thread) produces
 * byte-for-byte identical results to the synchronous legacy implementation.
 *
 * This is the critical correctness guarantee: moving the busy-wait off the
 * main thread must not change any fee amount.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('worker_threads');
const path = require('path');

const orderService = require('../src/services/orderService');

const WORKER_PATH = path.join(__dirname, '../src/workers/feeWorker.js');
const DEFAULT_BPS = 12;

/** Helper: run the fee worker and return a Promise<number>. */
function workerFee(qty, price, feeBps = DEFAULT_BPS) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_PATH, { workerData: { qty, price, feeBps } });
    w.once('message', ({ fee }) => resolve(fee));
    w.once('error', reject);
    w.once('exit', code => { if (code !== 0) reject(new Error(`exit ${code}`)); });
  });
}

/** The reference synchronous implementation (copied from orderService). */
function syncFee(qty, price, feeBps = DEFAULT_BPS) {
  return orderService.computeFee(qty, price); // uses same formula
}

// ── parity tests ───────────────────────────────────────────────────────────────

const CASES = [
  { qty: 1000, price: 100 },    // baseline from existing test → 120
  { qty: 1,    price: 1 },      // minimum → 0 (rounds down)
  { qty: 10000, price: 500 },   // large order
  { qty: 7,    price: 99.99 },  // non-round price
  { qty: 3,    price: 0.01 },   // tiny price → likely 0
  { qty: 9999, price: 227.5 },  // real AAPL-like price
  { qty: 5000, price: 415.2 },  // real MSFT-like price
];

for (const { qty, price } of CASES) {
  test(`worker fee matches sync fee for qty=${qty} price=${price}`, async () => {
    const [wf, sf] = await Promise.all([
      workerFee(qty, price),
      Promise.resolve(syncFee(qty, price)),
    ]);
    assert.strictEqual(wf, sf,
      `worker returned ${wf}, sync returned ${sf} for qty=${qty} price=${price}`);
  });
}

// ── correctness spot-check (matches the original test) ────────────────────────

test('worker fee: 1000 * 100 @ 12 bps = 120', async () => {
  const fee = await workerFee(1000, 100, 12);
  assert.strictEqual(fee, 120);
});

test('worker fee: rounding half-down (0.4999 bias)', async () => {
  // 1 * 1 * 12 / 10000 = 0.0012 → floor(0.0012 + 0.4999) = floor(0.5011) = 0
  const fee = await workerFee(1, 1, 12);
  assert.strictEqual(fee, 0);
});
