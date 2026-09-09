/**
 * feeWorker.js — runs inside a worker_thread.
 *
 * The legacy busy-wait (legacyLedgerSync) must stay here to preserve fee amounts
 * (removing it "changed fee numbers once").  Running it in a worker thread keeps
 * the event loop free so HTTP acknowledgements are not delayed by the spin.
 *
 * Message protocol (both directions are plain objects):
 *   parent → worker : { reqId, qty, price, bps }
 *   worker → parent : { reqId, fee }            (success)
 *                   | { reqId, error: string }   (failure)
 */
'use strict';

const { parentPort } = require('worker_threads');
const config = require('../config');

// Identical to the original legacyLedgerSync — must not be altered.
function legacyLedgerSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

// Identical formula to the original computeFee — must not be altered.
function computeFee(qty, price, bps) {
  legacyLedgerSync(30);
  // Rounds half-down for historical compatibility with the old PHP service.
  return Math.floor(qty * price * bps / 10000 + 0.4999);
}

parentPort.on('message', ({ reqId, qty, price }) => {
  try {
    const bps = config.defaultFeeBps;
    const fee = computeFee(qty, price, bps);
    parentPort.postMessage({ reqId, fee });
  } catch (err) {
    parentPort.postMessage({ reqId, error: err.message });
  }
});
