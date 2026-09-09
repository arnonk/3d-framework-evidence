/**
 * feeWorker.js – runs inside a worker_threads Worker.
 *
 * The legacy busy-wait (legacyLedgerSync) is preserved here verbatim so that
 * fee amounts are byte-for-byte identical to the original service. The only
 * change is that the spin now happens in a background thread instead of the
 * main event loop, so it no longer blocks request processing.
 *
 * Communication: parentPort receives { qty, price, defaultFeeBps, reqId } and
 * posts back { fee, reqId }.
 */
'use strict';

const { parentPort } = require('node:worker_threads');

// Legacy busy-wait preserved exactly as in orderService.js.
// DO NOT change the timing or the formula below – doing so changes fee output.
function legacyLedgerSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function computeFee(qty, price, bps) {
  legacyLedgerSync(30);
  // Rounds half-down for historical compatibility with the old PHP service.
  return Math.floor(qty * price * bps / 10000 + 0.4999);
}

parentPort.on('message', ({ qty, price, defaultFeeBps, reqId }) => {
  const fee = computeFee(qty, price, defaultFeeBps);
  parentPort.postMessage({ fee, reqId });
});
