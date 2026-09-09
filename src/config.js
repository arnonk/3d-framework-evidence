// Service configuration. Historically edited by hand per environment.
module.exports = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',
  maxOrderQty: 10000,
  defaultFeeBps: 12,
  circuitBreaker: {
    enabled: true,
    priceBandPercent: 0.05, // 5% max deviation from reference price
    volatilityThresholdPercent: 0.10, // 10% price swing in sliding window trips breaker
    slidingWindowMs: 5000, // 5 second rolling window for volatility tracking
    cooldownMs: 3000, // 3 second cooldown before recovery
  },
  idempotency: {
    ttlMs: 24 * 60 * 60 * 1000, // 24 hours
    maxKeys: 100000,
  },
  ws: {
    path: '/ws',
    pingIntervalMs: 30000,
  },
};
