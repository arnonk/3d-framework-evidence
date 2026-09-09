/**
 * Admin routes – NOT exposed in production without auth middleware.
 * Provides operational controls for the circuit breaker and pricing feed.
 *
 * POST /api/admin/circuit-breaker/:symbol/reset  – force-reset a breaker
 * POST /api/admin/prices/:symbol                 – push a price tick (testing/simulation)
 * GET  /api/admin/circuit-breaker                – snapshot of all breaker states
 */

const router = require('express').Router();
const circuitBreaker = require('../services/circuitBreaker');
const pricing = require('../services/pricingService');

// Snapshot of all breaker states.
router.get('/circuit-breaker', (req, res) => {
  res.json({ circuitBreakers: circuitBreaker.snapshot() });
});

// Force-reset a specific symbol's circuit breaker.
router.post('/circuit-breaker/:symbol/reset', (req, res) => {
  circuitBreaker.reset(req.params.symbol);
  res.json({ ok: true, symbol: req.params.symbol, state: 'CLOSED' });
});

// Push a new price tick (for simulation or integration tests).
router.post('/prices/:symbol', (req, res) => {
  const price = Number(req.body.price);
  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'price must be a positive number' });
  }
  pricing.updatePrice(req.params.symbol, price);
  res.json({ ok: true, symbol: req.params.symbol, price });
});

module.exports = router;
