const router = require('express').Router();
const wsHub = require('../services/wsHub');
const circuitBreaker = require('../services/circuitBreaker');

router.get('/health', (req, res) =>
  res.json({
    status: 'up',
    ts: Date.now(),
    wsClients: wsHub.clientCount(),
    circuitBreakers: circuitBreaker.snapshot(),
  })
);

module.exports = router;
