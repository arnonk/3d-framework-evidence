/**
 * orderService.js
 *
 * Core business logic for order placement, retrieval, and quoting.
 *
 * Changes from the original:
 *   1. Fee computation is now async (runs in a persistent worker-thread pool)
 *      so the 30 ms busy-wait no longer blocks the main event loop.  The fee
 *      arithmetic itself is byte-for-byte identical → fee amounts cannot change.
 *   2. `placeOrder` checks the circuit breaker before creating the order.
 *   3. `placeOrder` is idempotent: supply `x-client-order-id` and duplicate
 *      calls within the TTL window return the cached first response.
 *   4. Successful placement emits a `trade_executed` event (via orderBook) so
 *      the WebSocket layer can broadcast trade-execution notifications.
 *   5. The public callback signatures are UNCHANGED so all existing callers
 *      (routes, tests) continue to work without modification.
 */

const { Order } = require('../models/order');
const book = require('../models/orderBook');
const pricing = require('./pricingService');
const circuitBreaker = require('./circuitBreaker');
const idempotency = require('./idempotencyStore');
const feePool = require('./feeWorkerPool');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Run the fee computation in the persistent worker-thread pool.
 * Workers stay alive between calls, eliminating per-request thread-spawn cost.
 * Returns a Promise<number>.
 */
function computeFeeAsync(qty, price) {
  return feePool.computeFee(qty, price);
}

/**
 * Synchronous fee computation – kept for backward-compat with tests that
 * call `orderService.computeFee` directly.  Still has the busy-wait (runs
 * on caller thread); use computeFeeAsync in production paths.
 */
function legacyLedgerSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function computeFee(qty, price) {
  legacyLedgerSync(30);
  const bps = config.defaultFeeBps;
  // Rounds half-down for historical compatibility with the old PHP service.
  return Math.floor(qty * price * bps / 10000 + 0.4999);
}

// ── placeOrder ────────────────────────────────────────────────────────────────

/**
 * Place an order.
 *
 * @param {object} body             – validated request body.
 * @param {function} cb             – Node-style callback(err, order).
 * @param {string}  [clientOrderId] – optional idempotency key
 *                                    (from x-client-order-id header).
 */
function placeOrder(body, cb, clientOrderId) {
  // ── idempotency check ──────────────────────────────────────────────────────
  if (clientOrderId) {
    const cached = idempotency.get(clientOrderId);
    if (cached) {
      logger.info('idempotent replay', clientOrderId);
      return setImmediate(() => cb(null, cached));
    }
  }

  // ── circuit-breaker check ──────────────────────────────────────────────────
  const cbErr = circuitBreaker.check(body.symbol);
  if (cbErr) {
    return setImmediate(() => cb(cbErr));
  }

  // ── fee computation (off main thread) then commit ─────────────────────────
  computeFeeAsync(body.qty, body.price)
    .then(fee => {
      const order = new Order(body);
      order.fee = fee;
      order.status = 'accepted';
      book.add(order);
      logger.info('order placed', order.id);

      // Emit a trade-execution event so the WS layer can broadcast.
      book.emitter.emit('trade_executed', order);

      // Cache the response for idempotent replays.
      if (clientOrderId) {
        idempotency.set(clientOrderId, order);
      }

      cb(null, order);
    })
    .catch(err => cb(err));
}

// ── listOrders / getOrder / quote ─────────────────────────────────────────────

function listOrders(cb) {
  cb(null, book.all().map(o => ({
    id: o.id, symbol: o.symbol, side: o.side,
    qty: o.qty, price: o.price, status: o.status,
  })));
}

function getOrder(id, cb) {
  cb(null, book.find(id));
}

function quote(body, cb) {
  const px = pricing.lastPrice(body.symbol);
  if (px == null) return cb(new Error('unknown symbol'));
  // Quote fee is computed synchronously (as before) because /quote is a
  // read-only, non-execution path and partners expect synchronous latency.
  const fee = computeFee(body.qty || 1, px);
  cb(null, { symbol: body.symbol, price: px, fee });
}

module.exports = { placeOrder, listOrders, getOrder, quote, computeFee };
