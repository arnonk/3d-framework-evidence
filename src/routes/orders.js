/**
 * routes/orders.js
 *
 * REST routes for order placement and retrieval.
 *
 * Response shapes are FROZEN — external partners parse them.
 * Do not rename or reorder fields in existing responses.
 *
 * Idempotency-Key header: clients may supply any opaque string.
 * The same order will not be placed twice for the same key within 24 h.
 * The response for a duplicate is identical to the original (HTTP 200, not 201).
 */
'use strict';

const router = require('express').Router();
const orderService = require('../services/orderService');
const { validateOrder } = require('../utils/validate');

// Place an order (legacy callback style - do not break the response shape,
// external partners parse these fields positionally in some integrations).
router.post('/orders', (req, res) => {
  const err = validateOrder(req.body);
  if (err) return res.status(400).json({ error: err });

  // Attach idempotency key from header (if provided) before passing to service.
  const body = {
    ...req.body,
    idempotencyKey: req.headers['idempotency-key'] || null,
  };

  orderService.placeOrder(body, (e, order) => {
    if (e) {
      // Circuit-breaker trip: return 503 with retry guidance.
      if (e.code === 'CIRCUIT_OPEN') {
        return res.status(503).json({
          error: e.message,
          retriableAfterMs: e.retriableAfterMs,
        });
      }
      return res.status(500).json({ error: e.message });
    }
    // FROZEN response shape: { order_id, status, fee }
    res.status(201).json({ order_id: order.id, status: order.status, fee: order.fee });
  });
});

router.get('/orders', (req, res) => {
  orderService.listOrders((e, orders) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ orders });
  });
});

router.get('/orders/:id', (req, res) => {
  orderService.getOrder(req.params.id, (e, order) => {
    if (e) return res.status(500).json({ error: e.message });
    if (!order) return res.status(404).json({ error: 'order not found' });
    res.json(order);
  });
});

// DEPRECATED: use POST /orders. Kept because partner "hermes" still calls it.
router.post('/quote', (req, res) => {
  orderService.quote(req.body, (e, q) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json(q);
  });
});

module.exports = router;
