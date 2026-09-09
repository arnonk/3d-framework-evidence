const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { CircuitBreakerService } = require('../src/services/circuitBreakerService');

let cb;

beforeEach(() => {
  cb = new CircuitBreakerService({
    enabled: true,
    priceBandPercent: 0.05, // 5%
    volatilityThresholdPercent: 0.10, // 10%
    slidingWindowMs: 200, // 200ms window for fast testing
    cooldownMs: 100, // 100ms cooldown for fast testing
  });
  cb.setReferencePrice('AAPL', 100.0);
});

test('circuit breaker: price within ±5% band is accepted', () => {
  // Reference price is 100.0, band is [95.0, 105.0]
  assert.equal(cb.validateOrder('AAPL', 100.0).valid, true);
  assert.equal(cb.validateOrder('AAPL', 95.5).valid, true);
  assert.equal(cb.validateOrder('AAPL', 104.9).valid, true);
});

test('circuit breaker: price outside ±5% band is rejected', () => {
  // Below 95.0
  const low = cb.validateOrder('AAPL', 94.0);
  assert.equal(low.valid, false);
  assert.match(low.reason, /outside price band/i);

  // Above 105.0
  const high = cb.validateOrder('AAPL', 106.0);
  assert.equal(high.valid, false);
  assert.match(high.reason, /outside price band/i);
});

test('circuit breaker: volatility spike trips breaker to OPEN state', () => {
  const now = Date.now();
  cb.recordPriceUpdate('AAPL', 100.0, now);
  cb.recordPriceUpdate('AAPL', 112.0, now + 10); // 12% jump in 10ms

  const status = cb.getStatus('AAPL');
  assert.equal(status.state, 'OPEN');
  assert.match(status.tripReason, /volatility spike/i);

  // When OPEN, orders even at fair price are rejected
  const res = cb.validateOrder('AAPL', 112.0);
  assert.equal(res.valid, false);
  assert.equal(res.state, 'OPEN');
  assert.match(res.reason, /circuit breaker active/i);
});

test('circuit breaker: automatic cooldown recovery resets to CLOSED', async () => {
  cb.trip('AAPL', 'Testing spike');
  assert.equal(cb.getStatus('AAPL').state, 'OPEN');

  // Wait for cooldown period (100ms)
  await new Promise(resolve => setTimeout(resolve, 120));

  const status = cb.getStatus('AAPL');
  assert.equal(status.state, 'CLOSED');

  // Orders can be placed again
  assert.equal(cb.validateOrder('AAPL', 100.0).valid, true);
});

test('circuit breaker: manual trip and reset controls', () => {
  cb.trip('MSFT', 'Manual emergency pause');
  assert.equal(cb.getStatus('MSFT').state, 'OPEN');

  cb.reset('MSFT');
  assert.equal(cb.getStatus('MSFT').state, 'CLOSED');
});
