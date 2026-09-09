/**
 * test/circuitBreaker.test.js
 *
 * Unit tests for the price-band circuit breaker.
 *
 * Strategy: drive the breaker directly via `pricing.updatePrice` ticks
 * (the same path production uses) and override config values in-process so
 * we don't need to wait 30 seconds for real cooldowns.
 */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const config = require('../src/config');
const pricing = require('../src/services/pricingService');
const cb = require('../src/services/circuitBreaker');

// ── helpers ────────────────────────────────────────────────────────────────────

/** Temporarily install tight config so we can trip the breaker quickly. */
function tightConfig() {
  const orig = { ...config.circuitBreaker };
  config.circuitBreaker.maxMovePct = 0.05;   // 5 %
  config.circuitBreaker.windowMs   = 60_000; // wide window so ticks accumulate
  config.circuitBreaker.cooldownMs = 50;     // 50 ms so we can test HALF_OPEN fast
  return () => Object.assign(config.circuitBreaker, orig);
}

function sym(suffix) {
  // Use unique symbol names per test to avoid cross-test pollution.
  return 'TEST_' + suffix + '_' + Date.now();
}

// ── tests ──────────────────────────────────────────────────────────────────────

test('circuit breaker: starts CLOSED', () => {
  const restore = tightConfig();
  try {
    const s = sym('INIT');
    assert.strictEqual(cb.check(s), null);
    assert.strictEqual(cb._breakers[s].state, cb.STATE.CLOSED);
  } finally { restore(); }
});

test('circuit breaker: stays CLOSED when price is stable', () => {
  const restore = tightConfig();
  try {
    const s = sym('STABLE');
    // Push three ticks within 2 % of each other.
    pricing.updatePrice(s, 100);
    pricing.updatePrice(s, 101);
    pricing.updatePrice(s, 100.5);
    assert.strictEqual(cb.check(s), null, 'should remain CLOSED');
  } finally { restore(); }
});

test('circuit breaker: trips OPEN on >5% move', () => {
  const restore = tightConfig();
  try {
    const s = sym('TRIP');
    pricing.updatePrice(s, 100);
    pricing.updatePrice(s, 110); // 10 % move → should trip
    const err = cb.check(s);
    assert.ok(err instanceof Error, 'should return an Error when OPEN');
    assert.match(err.message, /Circuit breaker OPEN/);
    assert.strictEqual(cb._breakers[s].state, cb.STATE.OPEN);
  } finally { restore(); }
});

test('circuit breaker: rejects order when OPEN', () => {
  const restore = tightConfig();
  try {
    const s = sym('REJECT');
    pricing.updatePrice(s, 100);
    pricing.updatePrice(s, 115); // 15 % → OPEN
    // Check twice to confirm repeated rejection.
    assert.ok(cb.check(s) instanceof Error);
    assert.ok(cb.check(s) instanceof Error);
  } finally { restore(); }
});

test('circuit breaker: transitions OPEN → HALF_OPEN after cooldown', async () => {
  const restore = tightConfig();
  config.circuitBreaker.cooldownMs = 30; // override to 30 ms
  try {
    const s = sym('HALFOPEN');
    pricing.updatePrice(s, 100);
    pricing.updatePrice(s, 115); // trip
    assert.strictEqual(cb._breakers[s].state, cb.STATE.OPEN);

    await new Promise(r => setTimeout(r, 50)); // wait past cooldown

    // Next tick drives the OPEN→HALF_OPEN transition.
    pricing.updatePrice(s, 115.1);

    assert.strictEqual(cb._breakers[s].state, cb.STATE.HALF_OPEN);
  } finally { restore(); }
});

test('circuit breaker: HALF_OPEN → CLOSED when price calms down', async () => {
  const restore = tightConfig();
  config.circuitBreaker.cooldownMs = 30;
  config.circuitBreaker.windowMs   = 100; // short window so old spiky ticks expire
  try {
    const s = sym('RECOVER');
    pricing.updatePrice(s, 100);
    pricing.updatePrice(s, 115); // trip
    assert.strictEqual(cb._breakers[s].state, cb.STATE.OPEN);

    // Wait for cooldown + window to expire so spike ticks are pruned.
    await new Promise(r => setTimeout(r, 150));

    pricing.updatePrice(s, 115.1); // drives OPEN → HALF_OPEN
    assert.strictEqual(cb._breakers[s].state, cb.STATE.HALF_OPEN);

    // Now check: window is clean, move is tiny → probe succeeds → CLOSED.
    const err = cb.check(s);
    assert.strictEqual(err, null, 'should be CLOSED after successful probe');
    assert.strictEqual(cb._breakers[s].state, cb.STATE.CLOSED);
  } finally { restore(); }
});

test('circuit breaker: reset() forces back to CLOSED', () => {
  const restore = tightConfig();
  try {
    const s = sym('RESET');
    pricing.updatePrice(s, 100);
    pricing.updatePrice(s, 120); // trip
    assert.ok(cb.check(s) instanceof Error);

    cb.reset(s);
    assert.strictEqual(cb.check(s), null, 'should be CLOSED after reset');
  } finally { restore(); }
});

test('circuit breaker: snapshot includes tripped symbols', () => {
  const restore = tightConfig();
  try {
    const s = sym('SNAP');
    pricing.updatePrice(s, 100);
    pricing.updatePrice(s, 120);
    const snap = cb.snapshot();
    assert.ok(snap[s], 'symbol should appear in snapshot');
    assert.strictEqual(snap[s].state, cb.STATE.OPEN);
  } finally { restore(); }
});

test('circuit breaker: independent symbols do not affect each other', () => {
  const restore = tightConfig();
  try {
    const stable  = sym('INDEP_STABLE');
    const volatile = sym('INDEP_VOLAT');
    pricing.updatePrice(stable,   100);
    pricing.updatePrice(stable,   101);
    pricing.updatePrice(volatile, 100);
    pricing.updatePrice(volatile, 120); // trip volatile only
    assert.strictEqual(cb.check(stable), null, 'stable should remain CLOSED');
    assert.ok(cb.check(volatile) instanceof Error, 'volatile should be OPEN');
  } finally { restore(); }
});
