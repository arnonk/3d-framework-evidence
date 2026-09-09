/**
 * feeWorkerPoolEntry.js
 *
 * Long-lived worker thread used by feeWorkerPool.js.
 * Receives { qty, price, feeBps } messages and posts back { fee } or { error }.
 * Never exits voluntarily — the pool manager calls worker.terminate() on shutdown.
 *
 * The fee arithmetic is byte-for-byte identical to the original legacyLedgerSync
 * path so fee amounts cannot change.
 */
'use strict';

const { parentPort } = require('worker_threads');

function legacyLedgerSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function computeFee(qty, price, feeBps) {
  legacyLedgerSync(30);
  // Rounds half-down for historical compatibility with the old PHP service.
  return Math.floor(qty * price * feeBps / 10000 + 0.4999);
}

parentPort.on('message', ({ qty, price, feeBps }) => {
  try {
    const fee = computeFee(qty, price, feeBps);
    parentPort.postMessage({ fee });
  } catch (e) {
    parentPort.postMessage({ error: e.message });
  }
});
