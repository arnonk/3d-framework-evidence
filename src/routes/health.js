const router = require('express').Router();
const circuitBreaker = require('../services/circuitBreaker');

router.get('/health', (req, res) => res.json({
  status: 'up',
  ts: Date.now(),
  circuitBreakers: circuitBreaker.snapshot(),
}));

module.exports = router;
