/**
 * circuitBreaker.js
 *
 * Per-symbol price-band circuit breaker.
 *
 * States (standard three-state model):
 *   CLOSED   – normal; orders flow through.
 *   OPEN     – volatility spike detected; orders rejected until cooldown expires.
 *   HALF_OPEN – cooldown expired; next order is a probe.  If it succeeds the
 *               breaker resets to CLOSED.  (For order routing "success" means
 *               the price is back inside the band.)
 *
 * Algorithm:
 *   On each price tick we record the price in a rolling window (windowMs).
 *   We compute the range (max − min) / min over the window.  If that exceeds
 *   maxMovePct the breaker trips to OPEN for cooldownMs.
 */

const config = require('../config');
const pricing = require('./pricingService');
const logger = require('../utils/logger');

const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

// Per-symbol state.
// { state, openedAt, ticks: [{ price, ts }] }
const breakers = {};

function getOrCreate(symbol) {
  if (!breakers[symbol]) {
    breakers[symbol] = { state: STATE.CLOSED, openedAt: null, ticks: [] };
  }
  return breakers[symbol];
}

/** Prune ticks older than the rolling window. */
function pruneTicks(b) {
  const cutoff = Date.now() - config.circuitBreaker.windowMs;
  b.ticks = b.ticks.filter(t => t.ts >= cutoff);
}

/** Compute (max − min) / min for the current tick window. */
function computeMovePct(ticks) {
  if (ticks.length < 2) return 0;
  let mn = Infinity, mx = -Infinity;
  for (const t of ticks) {
    if (t.price < mn) mn = t.price;
    if (t.price > mx) mx = t.price;
  }
  return mn > 0 ? (mx - mn) / mn : 0;
}

/** Called on every price tick. */
function onTick({ symbol, price }) {
  const b = getOrCreate(symbol);
  b.ticks.push({ price, ts: Date.now() });
  pruneTicks(b);

  if (b.state === STATE.OPEN) {
    // Check if cooldown has expired → move to HALF_OPEN.
    if (Date.now() - b.openedAt >= config.circuitBreaker.cooldownMs) {
      b.state = STATE.HALF_OPEN;
      logger.info(`[circuit-breaker] ${symbol}: OPEN → HALF_OPEN`);
    }
    return; // While open/half-open, don't re-evaluate from ticks alone.
  }

  const move = computeMovePct(b.ticks);
  if (move > config.circuitBreaker.maxMovePct) {
    b.state = STATE.OPEN;
    b.openedAt = Date.now();
    logger.warn(
      `[circuit-breaker] ${symbol}: TRIPPED (move=${(move * 100).toFixed(2)}%)` +
      ` → OPEN for ${config.circuitBreaker.cooldownMs}ms`,
    );
  }
}

/**
 * Check whether an order for this symbol is allowed.
 * Returns null if allowed, or an Error with a human-readable message.
 */
function check(symbol) {
  const b = getOrCreate(symbol);

  if (b.state === STATE.CLOSED) return null;

  if (b.state === STATE.OPEN) {
    const remainMs = config.circuitBreaker.cooldownMs - (Date.now() - b.openedAt);
    return new Error(
      `Circuit breaker OPEN for ${symbol}: excessive volatility. ` +
      `Retry after ${Math.ceil(remainMs / 1000)}s.`,
    );
  }

  if (b.state === STATE.HALF_OPEN) {
    // Probe: evaluate current window move.  If it has calmed down, reset.
    pruneTicks(b);
    const move = computeMovePct(b.ticks);
    if (move <= config.circuitBreaker.maxMovePct) {
      b.state = STATE.CLOSED;
      logger.info(`[circuit-breaker] ${symbol}: HALF_OPEN → CLOSED (probe ok, move=${(move * 100).toFixed(2)}%)`);
      return null;
    }
    // Still volatile – reopen.
    b.state = STATE.OPEN;
    b.openedAt = Date.now();
    logger.warn(`[circuit-breaker] ${symbol}: HALF_OPEN → OPEN (still volatile)`);
    return new Error(`Circuit breaker re-opened for ${symbol}: still volatile.`);
  }

  return null;
}

/** Returns a snapshot of all breaker states (for health/debug endpoints). */
function snapshot() {
  return Object.fromEntries(
    Object.entries(breakers).map(([sym, b]) => [sym, { state: b.state, openedAt: b.openedAt }]),
  );
}

/** Force-reset a breaker (useful for ops and tests). */
function reset(symbol) {
  if (breakers[symbol]) {
    breakers[symbol].state = STATE.CLOSED;
    breakers[symbol].openedAt = null;
    breakers[symbol].ticks = [];
  }
}

// Wire up to the pricing service.
pricing.emitter.on('tick', onTick);

module.exports = { check, snapshot, reset, STATE, _breakers: breakers };
