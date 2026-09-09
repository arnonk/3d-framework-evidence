// Service configuration. Historically edited by hand per environment.
module.exports = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',
  maxOrderQty: 10000,
  defaultFeeBps: 12,

  // Circuit breaker: pause execution when price deviates too far from anchor.
  circuitBreaker: {
    // Maximum allowed deviation (%) before the breaker trips open.
    bandPct: Number(process.env.CB_BAND_PCT) || 5,
    // How long (ms) the breaker stays open before allowing retries.
    cooldownMs: Number(process.env.CB_COOLDOWN_MS) || 30_000,
  },
};
