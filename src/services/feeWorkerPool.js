/**
 * feeWorkerPool.js
 *
 * A fixed-size pool of persistent worker threads for fee computation.
 * Workers stay alive between requests, eliminating the ~30 ms thread-spawn
 * overhead that would otherwise blow the p99 budget.
 *
 * The pool is initialised lazily on first use and is module-scoped so it is
 * shared across all callers in the same process.
 *
 * Usage:
 *   const pool = require('./feeWorkerPool');
 *   const fee  = await pool.computeFee(qty, price);
 */
'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../config');

const WORKER_SCRIPT = path.join(__dirname, '../workers/feeWorkerPoolEntry.js');

// Number of persistent workers.  One is enough for our sequential workload;
// increase if you parallelise order placement in the future.
const POOL_SIZE = Number(process.env.FEE_WORKER_POOL_SIZE) || 2;

// Each slot: { worker: Worker, busy: bool, resolve: fn|null, reject: fn|null }
const pool = [];
// Queue of pending { qty, price, resolve, reject } items waiting for a free worker.
const queue = [];

function makeWorker() {
  const slot = { worker: null, busy: false, resolve: null, reject: null };

  const w = new Worker(WORKER_SCRIPT);

  w.on('message', ({ fee, error }) => {
    const { resolve, reject } = slot;
    slot.resolve = null;
    slot.reject  = null;
    slot.busy    = false;

    if (error) {
      reject(new Error(error));
    } else {
      resolve(fee);
    }

    // Drain one item from the queue, if any.
    if (queue.length > 0) {
      const next = queue.shift();
      dispatch(slot, next);
    }
  });

  w.on('error', err => {
    if (slot.reject) slot.reject(err);
    slot.resolve = null;
    slot.reject  = null;
    slot.busy    = false;
    // Replace the broken worker.
    const idx = pool.indexOf(slot);
    if (idx !== -1) pool.splice(idx, 1);
    pool.push(makeWorker());
  });

  slot.worker = w;
  return slot;
}

function dispatch(slot, { qty, price, resolve, reject }) {
  slot.busy    = true;
  slot.resolve = resolve;
  slot.reject  = reject;
  slot.worker.postMessage({ qty, price, feeBps: config.defaultFeeBps });
}

function initPool() {
  for (let i = 0; i < POOL_SIZE; i++) pool.push(makeWorker());
}

/**
 * Compute the fee for a given qty × price.
 * Returns a Promise<number> that resolves once a pool worker finishes.
 */
function computeFee(qty, price) {
  // Lazy init on first call.
  if (pool.length === 0) initPool();

  return new Promise((resolve, reject) => {
    const free = pool.find(s => !s.busy);
    if (free) {
      dispatch(free, { qty, price, resolve, reject });
    } else {
      queue.push({ qty, price, resolve, reject });
    }
  });
}

/** Gracefully terminate all pool workers (call on server shutdown). */
async function shutdown() {
  await Promise.all(pool.map(s => s.worker.terminate()));
  pool.length = 0;
}

module.exports = { computeFee, shutdown };
