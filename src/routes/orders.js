const router = require('express').Router();
const orderService = require('../services/orderService');
const { validateOrder } = require('../utils/validate');

// Place an order (legacy callback style - do not break the response shape,
// external partners parse these fields positionally in some integrations).
router.post('/orders', (req, res) => {
  const err = validateOrder(req.body);
  if (err) return res.status(400).json({ error: err });
  const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey;
  orderService.placeOrder(req.body, idempotencyKey, (e, order) => {
    if (e) return res.status(500).json({ error: e.message });
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
