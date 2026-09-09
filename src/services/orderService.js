/**
 * orderService.js
 *
 * Core business logic for order placement, listing, retrieval, and quoting.
 *
 * Key changes from v1:
 *  - placeOrder is now async; fee computation runs in a worker-thread pool
 *    so the 30 ms busy-wait no longer blocks the event loop.
 *  - placeOrder is wrapped with idempotency deduplication.
 *  - Orders are checked against the price-band circuit breaker before
 *    acceptance; a tripped breaker returns a structured error (not a 500).
 *  - Successful placements broadcast order_update and book_snapshot over WS.
 *  - All public functions still accept a Node-style callback so the route
 *    layer (and its external-partner response shapes) stays unchanged.
 *  - computeFee is still exported for the existing unit test.
 */
'use strict';

const { Order } = require('../models/order');
const book = require('../models/orderBook');
const pricing = require('./pricingService');
const config = require('../config');
const logger = require('../utils/logger');
const feePool = require('../workers/feePool');
const idempotency = require('./idempotency');
const circuitBreaker = require('./circuitBreaker');
const wsHub = require('./wsHub');

// ---------------------------------------------------------------------------
// computeFee — synchronous shim kept for backward-compat with the existing
// unit test ("fee uses default bps with legacy rounding").  New internal code
// should call feePool.computeFee() instead.
// ---------------------------------------------------------------------------
function legacyLedgerSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function computeFee(qty, price) {
  legacyLedgerSync(30);
  const bps = config.defaultFeeBps;
  return Math.floor(qty * price * bps / 10000 + 0.4999);
}

// ---------------------------------------------------------------------------
// Internal async implementation — called by the idempotency wrapper.
// ---------------------------------------------------------------------------
async function _doPlaceOrder(body) {
  // Circuit-breaker check before we touch the order book.
  const cbResult = circuitBreaker.check(body.symbol, body.price);
  if (!cbResult.allowed) {
    const err = new Error(cbResult.reason);
    err.code = 'CIRCUIT_OPEN';
    err.retriableAfterMs = cbResult.retriableAfterMs;
    throw err;
  }

  const order = new Order(body);

  // Compute fee off the event loop (worker thread, same formula, same result).
  order.fee = await feePool.computeFee(order.qty, order.price);

  book.add(order);
  circuitBreaker.recordExecution(order.symbol, order.price);
  logger.info('order placed', order.id);

  // Real-time notifications (non-blocking; errors are logged, not propagated).
  try {
    wsHub.emitOrderUpdate(order);
    wsHub.emitBookSnapshot(order.symbol, book.forSymbol(order.symbol));
  } catch (wsErr) {
    logger.error('[ws] broadcast error', wsErr.message);
  }

  return order;
}

// ---------------------------------------------------------------------------
// Public API — callback-style to preserve existing route shapes exactly.
// ---------------------------------------------------------------------------

/**
 * Place an order. Idempotent when the caller supplies an idempotencyKey.
 *
 * @param {object}      body              - validated order fields
 * @param {string|null} body.idempotencyKey - optional dedup key
 * @param {Function}    cb(err, order)
 */
function placeOrder(body, cb) {
  const key = body.idempotencyKey || null;
  idempotency
    .withIdempotency(key, () => _doPlaceOrder(body))
    .then(({ result }) => setImmediate(() => cb(null, result)))
    .catch((err) => setImmediate(() => cb(err)));
}

function listOrders(cb) {
  cb(
    null,
    book.all().map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      qty: o.qty,
      price: o.price,
      status: o.status,
    }))
  );
}

function getOrder(id, cb) {
  cb(null, book.find(id));
}

function quote(body, cb) {
  const px = pricing.lastPrice(body.symbol);
  if (px == null) return cb(new Error('unknown symbol'));
  // Use the sync shim for quote — it's not on the hot acknowledgement path
  // and the fee amount must remain identical to the old behaviour.
  cb(null, { symbol: body.symbol, price: px, fee: computeFee(body.qty || 1, px) });
}

module.exports = { placeOrder, listOrders, getOrder, quote, computeFee };
