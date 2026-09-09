'use strict';
/**
 * test/circuitBreaker.test.js
 *
 * Verifies price-band circuit breaker behaviour:
 *   - Orders within the band are allowed.
 *   - Orders that breach the band trip the breaker.
 *   - Breaker stays open for cooldownMs; further orders are rejected.
 *   - Breaker resets after cooldown and re-anchors.
 *   - recordExecution updates the anchor price.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// Use a tight config for tests so we don't need real time delays.
process.env.CB_BAND_PCT = '5';
process.env.CB_COOLDOWN_MS = '100'; // 100 ms cooldown so tests finish fast

const circuitBreaker = require('../src/services/circuitBreaker');

beforeEach(() => circuitBreaker._reset());

test('allows order within price band', () => {
  // Anchor at 100; 4% deviation is within the 5% band.
  circuitBreaker.recordExecution('AAPL', 100);
  const result = circuitBreaker.check('AAPL', 104);
  assert.equal(result.allowed, true);
});

test('trips on deviation exceeding band', () => {
  circuitBreaker.recordExecution('AAPL', 100);
  const result = circuitBreaker.check('AAPL', 110); // 10% deviation
  assert.equal(result.allowed, false);
  assert.match(result.reason, /circuit open/);
  assert.ok(result.retriableAfterMs > 0);
});

test('rejects subsequent orders while open', () => {
  circuitBreaker.recordExecution('AAPL', 100);
  circuitBreaker.check('AAPL', 110); // trip
  const result = circuitBreaker.check('AAPL', 101); // within band but breaker is open
  assert.equal(result.allowed, false);
});

test('resets after cooldown and re-anchors', async () => {
  circuitBreaker.recordExecution('AAPL', 100);
  circuitBreaker.check('AAPL', 110); // trip

  // Wait for cooldown to expire.
  await new Promise((r) => setTimeout(r, 150));

  // First post-cooldown check re-anchors to the new price.
  const result = circuitBreaker.check('AAPL', 110);
  assert.equal(result.allowed, true, 'should be allowed after cooldown');

  // Subsequent check with small deviation from new anchor is also fine.
  const result2 = circuitBreaker.check('AAPL', 112);
  assert.equal(result2.allowed, true);
});

test('independent symbols have independent breakers', () => {
  circuitBreaker.recordExecution('AAPL', 100);
  circuitBreaker.recordExecution('MSFT', 200);

  circuitBreaker.check('AAPL', 120); // trip AAPL

  assert.equal(circuitBreaker.check('AAPL', 101).allowed, false, 'AAPL should be open');
  assert.equal(circuitBreaker.check('MSFT', 202).allowed, true, 'MSFT should be closed');
});

test('snapshot reflects current state', () => {
  circuitBreaker.recordExecution('TSLA', 250);
  circuitBreaker.check('TSLA', 300); // trip
  const snap = circuitBreaker.snapshot();
  assert.equal(snap['TSLA'].status, 'open');
});
