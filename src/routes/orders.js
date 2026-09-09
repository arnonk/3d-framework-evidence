const router = require('express').Router();
const orderService = require('../services/orderService');
const { engine } = require('../models/orderBook');
const { circuitBreakerService } = require('../services/circuitBreakerService');
const { validateOrder } = require('../utils/validate');

// Place an order (legacy callback style - do not break the response shape,
// external partners parse these fields positionally in some integrations).
router.post('/orders', (req, res) => {
  const err = validateOrder(req.body);
  if (err) return res.status(400).json({ error: err });

  orderService.placeOrder(req.body, { headers: req.headers }, (e, order) => {
    if (e) {
      const statusCode = e.statusCode || (e.code === 'CIRCUIT_BREAKER_VIOLATION' ? 422 : 500);
      return res.status(statusCode).json({ error: e.message });
    }
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

// Operational endpoint: L2 Order Book Depth
router.get('/book/:symbol', (req, res) => {
  const depth = engine.getDepth(req.params.symbol);
  res.json(depth);
});

// Operational endpoint: Circuit Breaker Status
router.get('/circuit-breakers', (req, res) => {
  res.json({ circuitBreakers: circuitBreakerService.getAllStatuses() });
});

// Operational endpoint: Reset Circuit Breaker for a Symbol
router.post('/circuit-breakers/:symbol/reset', (req, res) => {
  circuitBreakerService.reset(req.params.symbol);
  res.json({ status: 'ok', symbol: req.params.symbol, state: 'CLOSED' });
});

module.exports = router;
