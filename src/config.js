// Service configuration. Historically edited by hand per environment.
module.exports = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',
  maxOrderQty: 10000,
  defaultFeeBps: 12,

  // Circuit-breaker: pause execution if price moves more than this %
  // within the rolling window.
  circuitBreaker: {
    // Maximum allowed price-change (as a fraction) within the window.
    // e.g. 0.05 = 5 %
    maxMovePct: Number(process.env.CB_MAX_MOVE_PCT) || 0.05,
    // Rolling window length in milliseconds.
    windowMs: Number(process.env.CB_WINDOW_MS) || 10_000,
    // How long the breaker stays OPEN before auto-resetting to HALF-OPEN.
    cooldownMs: Number(process.env.CB_COOLDOWN_MS) || 30_000,
  },

  // Idempotency cache TTL – how long we remember a clientOrderId.
  idempotencyTtlMs: Number(process.env.IDEMPOTENCY_TTL_MS) || 300_000,
};
