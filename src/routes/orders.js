/**
 * routes/orders.js
 *
 * REST route handlers.  Response shapes are kept byte-for-byte identical to
 * the original so external partners are unaffected.
 *
 * New behaviour:
 *   - POST /orders reads the optional `Idempotency-Key` header and forwards it
 *     to orderService.placeOrder.  Idempotent retries return HTTP 200 instead
 *     of 201 so the caller can detect a cached response if they care.
 *   - POST /orders returns a `circuit_open` 503 when the breaker is tripped.
 *   - GET  /circuit  exposes the current circuit breaker state for observability.
 *   - POST /circuit/:symbol/reset  allows ops to force-reset a breaker (admin).
 */
'use strict';

const router = require('express').Router();
const orderService = require('../services/orderService');
const circuitBreaker = require('../services/circuitBreaker');
const { validateOrder } = require('../utils/validate');

// ---------------------------------------------------------------------------
// POST /api/orders
// ---------------------------------------------------------------------------
// Place an order (legacy callback style - do not break the response shape,
// external partners parse these fields positionally in some integrations).
router.post('/orders', (req, res) => {
  const err = validateOrder(req.body);
  if (err) return res.status(400).json({ error: err });

  const idempotencyKey = req.headers['idempotency-key'] || null;

  orderService.placeOrder(req.body, idempotencyKey, (e, order) => {
    if (e) {
      if (e.code === 'CIRCUIT_OPEN') {
        return res.status(503).json({ error: e.message, code: 'CIRCUIT_OPEN' });
      }
      return res.status(500).json({ error: e.message });
    }
    // Use 200 for idempotent replays so the caller can distinguish
    const statusCode = idempotencyKey && order._idempotentReplay ? 200 : 201;
    res.status(statusCode).json({ order_id: order.id, status: order.status, fee: order.fee });
  });
});

// ---------------------------------------------------------------------------
// GET /api/orders
// ---------------------------------------------------------------------------
router.get('/orders', (req, res) => {
  orderService.listOrders((e, orders) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ orders });
  });
});

// ---------------------------------------------------------------------------
// GET /api/orders/:id
// ---------------------------------------------------------------------------
router.get('/orders/:id', (req, res) => {
  orderService.getOrder(req.params.id, (e, order) => {
    if (e) return res.status(500).json({ error: e.message });
    if (!order) return res.status(404).json({ error: 'order not found' });
    res.json(order);
  });
});

// ---------------------------------------------------------------------------
// POST /api/quote  (DEPRECATED – kept for partner "hermes")
// ---------------------------------------------------------------------------
router.post('/quote', (req, res) => {
  orderService.quote(req.body, (e, q) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json(q);
  });
});

// ---------------------------------------------------------------------------
// GET /api/circuit  – observability endpoint
// ---------------------------------------------------------------------------
router.get('/circuit', (req, res) => {
  res.json(circuitBreaker.status());
});

// ---------------------------------------------------------------------------
// POST /api/circuit/:symbol/reset  – ops / admin reset
// ---------------------------------------------------------------------------
router.post('/circuit/:symbol/reset', (req, res) => {
  circuitBreaker.reset(req.params.symbol.toUpperCase());
  res.json({ ok: true, symbol: req.params.symbol.toUpperCase(), status: circuitBreaker.status() });
});

module.exports = router;
