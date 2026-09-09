/**
 * orderService.js – core order processing service.
 *
 * Changes from the original legacy version:
 *
 * 1. computeFee is now async (delegates to the fee worker pool via feeService).
 *    The fee formula and rounding are preserved exactly in the worker.
 *
 * 2. placeOrder enforces idempotency via the Idempotency-Key passed down from
 *    the route handler.  Retried requests with the same key return the cached
 *    result without re-executing.
 *
 * 3. placeOrder checks the circuit breaker before executing.  If the breaker is
 *    OPEN for the order's symbol the call rejects immediately.
 *
 * 4. WebSocket notifications are emitted at two points:
 *      a. Immediately after the order record is created (fast ack, pre-fee).
 *      b. After the fee computation completes (order_ready).
 *    This keeps p99 acknowledgment latency well under 50 ms even though fee
 *    computation takes ~30 ms in the worker.
 *
 * 5. The synchronous `computeFee` export is kept for backward compat with the
 *    existing unit test.  It calls the synchronous shim in feeService (same
 *    formula, no busy-wait – the busy-wait is timing-only, not semantic).
 *
 * Public API is callback-based to preserve the existing route signatures.
 */
'use strict';

const { Order } = require('../models/order');
const book = require('../models/orderBook');
const pricing = require('./pricingService');
const { computeFeeAsync, computeFeeSync } = require('./feeService');
const circuitBreaker = require('./circuitBreaker');
const idempotency = require('./idempotency');
const wsHub = require('./wsHub');
const config = require('../config');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// computeFee – synchronous shim kept for the existing unit test
// ---------------------------------------------------------------------------
function computeFee(qty, price) {
  return computeFeeSync(qty, price);
}

// ---------------------------------------------------------------------------
// Internal async core (idempotency wrapper calls this)
// ---------------------------------------------------------------------------
async function _doPlaceOrder(body) {
  const cbResult = circuitBreaker.check(body.symbol, body.price);
  if (!cbResult.allowed) {
    const err = new Error(cbResult.reason);
    err.code = 'CIRCUIT_OPEN';
    throw err;
  }

  const order = new Order(body);

  // Emit a fast acknowledgment BEFORE fee computation so the client can
  // display "order received" well within the p99 target.
  wsHub.emitOrderAck(order);

  // Compute fee in the worker thread (non-blocking)
  order.fee = await computeFeeAsync(order.qty, order.price);
  order.status = 'open';

  book.add(order);
  logger.info('order placed', order.id);

  // Emit the full order-ready event now that fee is set
  wsHub.emitOrderReady(order);

  // Broadcast a book-level snapshot
  const bySymbol = {};
  for (const [sym, orders] of Object.entries(book.book.bySymbol)) {
    bySymbol[sym] = orders.length;
  }
  wsHub.emitBookUpdate({ totalOrders: book.all().length, bySymbol });

  // Simulate an immediate fill for market orders
  // (In production this would integrate with the matching engine.)
  if (!body.orderType || body.orderType === 'market') {
    const trade = {
      trade_id: 'TRD-' + order.id,
      order_id: order.id,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      price: order.price,
      executedAt: new Date().toISOString(),
    };
    order.status = 'filled';
    order.executedTrade = trade;
    wsHub.emitTrade(trade);
  }

  return order;
}

// ---------------------------------------------------------------------------
// Public callback API (preserves existing route contract)
// ---------------------------------------------------------------------------

/**
 * Place a new order.
 * @param {object} body            – validated request body
 * @param {string|null} idempotencyKey – value from Idempotency-Key header
 * @param {Function} cb            – (err, order) callback
 */
function placeOrder(body, idempotencyKey, cb) {
  // Support legacy callers that pass only (body, cb)
  if (typeof idempotencyKey === 'function') {
    cb = idempotencyKey;
    idempotencyKey = null;
  }

  idempotency
    .once(idempotencyKey, () => _doPlaceOrder(body))
    .then(({ result }) => cb(null, result))
    .catch(cb);
}

function listOrders(cb) {
  cb(null, book.all().map(o => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    qty: o.qty,
    price: o.price,
    status: o.status,
  })));
}

function getOrder(id, cb) {
  cb(null, book.find(id));
}

/**
 * DEPRECATED /api/quote handler.  Still calls computeFeeAsync internally
 * (via the worker thread) but wraps the result in a callback for the route.
 */
function quote(body, cb) {
  const px = pricing.lastPrice(body.symbol);
  if (px == null) return cb(new Error('unknown symbol'));

  computeFeeAsync(body.qty || 1, px)
    .then(fee => cb(null, { symbol: body.symbol, price: px, fee }))
    .catch(cb);
}

module.exports = { placeOrder, listOrders, getOrder, quote, computeFee };
