/**
 * circuitBreaker.js – per-symbol price-band circuit breaker.
 *
 * How it works:
 *   - Each symbol has a reference price (set the first time an order arrives,
 *     or when the breaker resets after cooldown).
 *   - If the submitted order price deviates more than `bandPct` percent from
 *     the reference price, the breaker for that symbol trips (OPEN).
 *   - While OPEN, all new order placements for that symbol are rejected.
 *   - After `cooldownMs`, the breaker automatically resets to HALF_OPEN.
 *   - The next valid-priced order in HALF_OPEN closes the breaker and sets
 *     the new reference price.
 *
 * Configuration keys in config.js:
 *   circuitBreakerBandPct  – price deviation % that trips the breaker (default 5)
 *   circuitBreakerCooldownMs – auto-reset delay in ms (default 10 000)
 */
'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const EventEmitter = require('node:events');

const BAND_PCT = config.circuitBreakerBandPct || 5;
const COOLDOWN_MS = config.circuitBreakerCooldownMs || 10_000;

const CLOSED    = 'CLOSED';
const OPEN      = 'OPEN';
const HALF_OPEN = 'HALF_OPEN';

// emitter so wsHub can subscribe to state changes
const emitter = new EventEmitter();

// Map<symbol, { state, referencePrice, openedAt, timer }>
const breakers = new Map();

function _entry(symbol) {
  if (!breakers.has(symbol)) {
    breakers.set(symbol, { state: CLOSED, referencePrice: null, openedAt: null, timer: null });
  }
  return breakers.get(symbol);
}

/**
 * Check price and advance state machine.
 *
 * Returns:
 *   { allowed: true }           – execution may proceed; referencePrice updated if needed
 *   { allowed: false, reason }  – execution must be blocked
 */
function check(symbol, price) {
  const e = _entry(symbol);

  if (e.state === OPEN) {
    return { allowed: false, reason: `circuit open for ${symbol} – volatility spike detected` };
  }

  if (e.referencePrice === null) {
    // First order for this symbol – set reference and proceed
    e.referencePrice = price;
    return { allowed: true };
  }

  const deviation = Math.abs(price - e.referencePrice) / e.referencePrice * 100;

  if (deviation > BAND_PCT) {
    _trip(symbol, price);
    return { allowed: false, reason: `circuit open for ${symbol} – price ${price} deviates ${deviation.toFixed(2)}% from reference ${e.referencePrice}` };
  }

  if (e.state === HALF_OPEN) {
    // Good price after cooldown – close the breaker and refresh reference
    e.state = CLOSED;
    e.referencePrice = price;
    logger.info(`[circuit] ${symbol} CLOSED (recovered, new ref ${price})`);
    emitter.emit('change', { symbol, state: CLOSED, referencePrice: price });
  }

  return { allowed: true };
}

function _trip(symbol, triggerPrice) {
  const e = _entry(symbol);
  if (e.state === OPEN) return; // already open

  if (e.timer) clearTimeout(e.timer);

  e.state = OPEN;
  e.openedAt = Date.now();
  logger.warn(`[circuit] ${symbol} OPEN – trigger price ${triggerPrice}, ref ${e.referencePrice}`);
  emitter.emit('change', { symbol, state: OPEN, triggerPrice, referencePrice: e.referencePrice });

  e.timer = setTimeout(() => {
    e.state = HALF_OPEN;
    logger.info(`[circuit] ${symbol} HALF_OPEN after cooldown`);
    emitter.emit('change', { symbol, state: HALF_OPEN, referencePrice: e.referencePrice });
  }, COOLDOWN_MS);
  // Unref so the timer doesn't keep the process alive in tests
  if (e.timer.unref) e.timer.unref();
}

/**
 * Manually trip the breaker (e.g. from market-data feed).
 */
function trip(symbol, triggerPrice) {
  _trip(symbol, triggerPrice);
}

/**
 * Force-reset a breaker (admin / test use).
 */
function reset(symbol) {
  const e = _entry(symbol);
  if (e.timer) clearTimeout(e.timer);
  e.state = CLOSED;
  e.referencePrice = null;
  e.openedAt = null;
  e.timer = null;
  emitter.emit('change', { symbol, state: CLOSED, referencePrice: null });
}

/**
 * Return a snapshot of all breaker states.
 */
function status() {
  const out = {};
  for (const [sym, e] of breakers) {
    out[sym] = { state: e.state, referencePrice: e.referencePrice, openedAt: e.openedAt };
  }
  return out;
}

module.exports = { check, trip, reset, status, emitter, CLOSED, OPEN, HALF_OPEN };
