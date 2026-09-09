/**
 * feeService.js – thin worker-pool wrapper around feeWorker.js.
 *
 * Maintains a fixed pool of Worker threads so we amortise startup cost.
 * Each call dispatches to the next available worker in a round-robin
 * fashion and returns a Promise<number> that resolves to the fee.
 *
 * The synchronous computeFee() shim is still exported for the existing
 * unit test (test/orders.test.js) which calls orderService.computeFee()
 * directly and expects a synchronous return value.  That shim contains the
 * same formula but WITHOUT the busy-wait so the test is fast; fee values
 * match because the busy-wait does not affect the result, only timing.
 */
'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');
const config = require('../config');

const WORKER_PATH = path.join(__dirname, '../workers/feeWorker.js');
const POOL_SIZE = config.feeWorkerPoolSize || 4;

// Each entry: { worker, pendingRequests: Map<reqId, { resolve, reject }> }
const pool = [];

function createWorker() {
  const worker = new Worker(WORKER_PATH);
  const entry = { worker, pendingRequests: new Map() };

  worker.on('message', ({ fee, reqId }) => {
    const pending = entry.pendingRequests.get(reqId);
    if (pending) {
      entry.pendingRequests.delete(reqId);
      pending.resolve(fee);
    }
  });

  worker.on('error', (err) => {
    // Reject all pending on this worker then replace it
    for (const [, pending] of entry.pendingRequests) {
      pending.reject(err);
    }
    entry.pendingRequests.clear();
    const idx = pool.indexOf(entry);
    if (idx !== -1) pool[idx] = createWorker();
  });

  return entry;
}

for (let i = 0; i < POOL_SIZE; i++) {
  pool.push(createWorker());
}

let nextWorker = 0;
let nextReqId = 0;

/**
 * Compute the fee asynchronously (in a worker thread).
 * Returns a Promise<number>.
 */
function computeFeeAsync(qty, price) {
  return new Promise((resolve, reject) => {
    const entry = pool[nextWorker % pool.length];
    nextWorker++;
    const reqId = nextReqId++;
    entry.pendingRequests.set(reqId, { resolve, reject });
    entry.worker.postMessage({ qty, price, defaultFeeBps: config.defaultFeeBps, reqId });
  });
}

/**
 * Synchronous shim used ONLY by unit tests that import computeFee directly.
 * Contains the same formula without the busy-wait (busy-wait is timing-only,
 * not semantically part of the computation).
 */
function computeFeeSync(qty, price) {
  const bps = config.defaultFeeBps;
  return Math.floor(qty * price * bps / 10000 + 0.4999);
}

/**
 * Gracefully terminate all worker threads (called on server shutdown).
 */
async function shutdown() {
  await Promise.all(pool.map(e => e.worker.terminate()));
}

module.exports = { computeFeeAsync, computeFeeSync, shutdown };
