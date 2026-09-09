/**
 * feePool.js — a tiny pool of fee-worker threads.
 *
 * Keeps NUM_WORKERS worker threads alive and round-robins requests across them.
 * Each thread runs a 30 ms busy-wait so we need enough threads to absorb
 * concurrent fee calculations without queuing (default: 4).
 *
 * Usage:
 *   const feePool = require('./feePool');
 *   const fee = await feePool.computeFee(qty, price);
 *   await feePool.shutdown(); // call on graceful shutdown
 */
'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'feeWorker.js');
const NUM_WORKERS = Number(process.env.FEE_WORKERS) || 4;

let reqCounter = 0;

// pending: reqId -> { resolve, reject }
const pending = new Map();

function createWorker() {
  const w = new Worker(WORKER_PATH);
  w.on('message', ({ reqId, fee, error }) => {
    const p = pending.get(reqId);
    if (!p) return;
    pending.delete(reqId);
    if (error !== undefined) {
      p.reject(new Error(error));
    } else {
      p.resolve(fee);
    }
  });
  w.on('error', (err) => {
    // If a worker crashes, reject all its outstanding requests.
    // We don't know which reqIds belong to this worker, so we do a sweep.
    for (const [id, p] of pending) {
      p.reject(err);
      pending.delete(id);
    }
    // Replace the dead worker.
    const idx = workers.indexOf(w);
    if (idx !== -1) workers[idx] = createWorker();
  });
  return w;
}

const workers = [];
for (let i = 0; i < NUM_WORKERS; i++) workers.push(createWorker());

/**
 * Compute the fee for a given qty/price pair.
 * Returns a Promise<number> that resolves once a worker has finished.
 */
function computeFee(qty, price) {
  return new Promise((resolve, reject) => {
    const reqId = ++reqCounter;
    pending.set(reqId, { resolve, reject });
    // Round-robin across workers.
    const worker = workers[reqId % NUM_WORKERS];
    worker.postMessage({ reqId, qty, price });
  });
}

/**
 * Gracefully terminate all worker threads.
 * Call this during process shutdown.
 */
async function shutdown() {
  await Promise.all(workers.map((w) => w.terminate()));
}

module.exports = { computeFee, shutdown };
