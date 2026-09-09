/**
 * feeWorkerPool.js
 *
 * A fixed-size pool of persistent worker threads for fee computation.
 * Workers stay alive between requests, eliminating the ~30 ms thread-spawn
 * overhead that would otherwise blow the p99 budget.
 *
 * Lifecycle:
 *   • Workers are unref'd when idle (so the process can exit naturally in tests
 *     and after server shutdown without calling shutdown() explicitly).
 *   • Workers are ref'd while they hold a pending computation (so the promise
 *     resolves even if the event loop would otherwise be empty).
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

// Number of persistent workers.
const POOL_SIZE = Number(process.env.FEE_WORKER_POOL_SIZE) || 2;

// Each slot: { worker, busy }
const pool = [];
// Queue of pending { qty, price, resolve, reject }
const queue = [];

function makeWorker() {
  const slot = { worker: null, busy: false, resolve: null, reject: null };

  const w = new Worker(WORKER_SCRIPT);

  // Start unref'd – won't keep process alive when idle.
  w.unref();

  w.on('message', ({ fee, error }) => {
    const { resolve, reject } = slot;
    slot.resolve = null;
    slot.reject  = null;
    slot.busy    = false;

    // Worker is now idle – unref again so the process can exit.
    w.unref();

    if (error) reject(new Error(error));
    else       resolve(fee);

    // Drain one queued item, if any.
    if (queue.length > 0) {
      dispatch(slot, queue.shift());
    }
  });

  w.on('error', err => {
    const { reject } = slot;
    slot.resolve = null;
    slot.reject  = null;
    slot.busy    = false;
    w.unref();
    if (reject) reject(err);

    // Replace the broken worker with a fresh one.
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
  // ref while busy so the promise resolves even if the loop is otherwise empty.
  slot.worker.ref();
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
