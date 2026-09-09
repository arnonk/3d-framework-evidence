const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { MockMarketFeed } = require('./mocks/mockMarketFeed');
const { CircuitBreakerService } = require('../src/services/circuitBreakerService');
const { engine } = require('../src/models/orderBook');

let feed;
let cb;

beforeEach(() => {
  engine.clear();
  feed = new MockMarketFeed({ seed: 999, initialPrices: { AAPL: 200.0 }, volatility: 0.001 });
  cb = new CircuitBreakerService({
    enabled: true,
    priceBandPercent: 0.05,
    volatilityThresholdPercent: 0.10, // 10%
    slidingWindowMs: 500,
    cooldownMs: 150,
  });
  cb.setReferencePrice('AAPL', 200.0);
});

test('market feed: normal random walk stays within price band and does not trip breaker', () => {
  const ticks = feed.generateTicks('AAPL', 10, 0.001);
  for (const tick of ticks) {
    cb.recordPriceUpdate(tick.symbol, tick.price, tick.timestamp);
    const check = cb.validateOrder(tick.symbol, tick.price);
    assert.equal(check.valid, true);
  }

  const status = cb.getStatus('AAPL');
  assert.equal(status.state, 'CLOSED');
});

test('market feed: sudden 15% volatility spike trips circuit breaker and blocks execution', () => {
  // 1. Initial normal state
  assert.equal(cb.getStatus('AAPL').state, 'CLOSED');

  // 2. Volatility spike: +15% jump
  const spike = feed.spike('AAPL', 0.15);
  cb.recordPriceUpdate('AAPL', spike.price, spike.timestamp);

  // Circuit breaker should trip immediately
  const status = cb.getStatus('AAPL');
  assert.equal(status.state, 'OPEN');
  assert.match(status.tripReason, /volatility spike/i);

  // Attempting to place order should be rejected
  const validation = cb.validateOrder('AAPL', spike.price);
  assert.equal(validation.valid, false);
  assert.equal(validation.state, 'OPEN');
});

test('market feed: engine pauses execution during spike and resumes after cooldown', async () => {
  // Trip breaker with spike
  const spike = feed.spike('AAPL', 0.18);
  cb.recordPriceUpdate('AAPL', spike.price, spike.timestamp);

  assert.equal(cb.getStatus('AAPL').state, 'OPEN');

  // Wait for cooldown period (150ms)
  await new Promise(resolve => setTimeout(resolve, 180));

  // Cooldown expired: should reset to CLOSED
  const resetStatus = cb.getStatus('AAPL');
  assert.equal(resetStatus.state, 'CLOSED');

  // Reset reference price to current market level
  cb.setReferencePrice('AAPL', spike.price);

  // New order at current price is accepted
  const check = cb.validateOrder('AAPL', spike.price);
  assert.equal(check.valid, true);
});
