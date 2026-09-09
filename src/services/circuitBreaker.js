/**
 * circuitBreaker.js — price-band circuit breaker.
 *
 * For each symbol we remember the last "anchor" price.  When a new order
 * arrives, if its price deviates from the anchor by more than BAND_PCT percent
 * the breaker trips open for COOLDOWN_MS milliseconds.
 *
 * While open, order placement is rejected with a 503 so that a volatility spike
 * does not spray orders into a moving market.  After the cooldown the breaker
 * half-opens and the next successful order re-anchors the price.
 *
 * Config (all via src/config.js):
 *   circuitBreaker.bandPct      - max % deviation before tripping (default 5 %)
 *   circuitBreaker.cooldownMs   - open→half-open time in ms (default 30 000)
 */
'use strict';

const config = require('../config');
const logger = require('../utils/logger');

// symbol -> { anchor, state: 'closed'|'open', trippedAt }
const state = new Map();

function getOrInit(symbol, price) {
  if (!state.has(symbol)) {
    state.set(symbol, { anchor: price, status: 'closed', trippedAt: 0 });
  }
  return state.get(symbol);
}

/**
 * Check whether an order for `symbol` at `price` is allowed.
 *
 * Returns: { allowed: true }
 *        | { allowed: false, reason: string, retriableAfterMs: number }
 */
function check(symbol, price) {
  const { bandPct, cooldownMs } = config.circuitBreaker;
  const entry = getOrInit(symbol, price);
  const now = Date.now();

  if (entry.status === 'open') {
    const remaining = cooldownMs - (now - entry.trippedAt);
    if (remaining > 0) {
      return {
        allowed: false,
        reason: `circuit open for ${symbol} — volatility spike detected`,
        retriableAfterMs: remaining,
      };
    }
    // Cooldown elapsed: transition to half-open.
    entry.status = 'closed';
    entry.anchor = price; // re-anchor on first post-cooldown price
    logger.info(`[circuit] ${symbol} half-open — resetting anchor to ${price}`);
  }

  // Closed / half-open: evaluate deviation.
  const deviation = Math.abs(price - entry.anchor) / entry.anchor * 100;
  if (deviation > bandPct) {
    entry.status = 'open';
    entry.trippedAt = now;
    logger.warn(
      `[circuit] ${symbol} tripped — price ${price} deviates ${deviation.toFixed(2)}% from anchor ${entry.anchor}`
    );
    return {
      allowed: false,
      reason: `circuit open for ${symbol} — price moved ${deviation.toFixed(2)}% (limit ${bandPct}%)`,
      retriableAfterMs: cooldownMs,
    };
  }

  return { allowed: true };
}

/**
 * Update the anchor price after a successful order execution.
 * Call this only when order placement succeeds.
 */
function recordExecution(symbol, price) {
  const entry = state.get(symbol);
  if (entry) {
    entry.anchor = price;
  } else {
    state.set(symbol, { anchor: price, status: 'closed', trippedAt: 0 });
  }
}

/** For testing: reset all breaker state. */
function _reset() {
  state.clear();
}

/** For monitoring / health endpoints. */
function snapshot() {
  const out = {};
  for (const [sym, s] of state) {
    out[sym] = { status: s.status, anchor: s.anchor };
  }
  return out;
}

module.exports = { check, recordExecution, snapshot, _reset };
