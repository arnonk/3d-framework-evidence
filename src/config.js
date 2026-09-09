// Service configuration.
module.exports = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',
  maxOrderQty: 10000,
  defaultFeeBps: 12,
  circuitBreakerBandPct: 5.0,     // +/- 5% allowable price corridor
  maxVolatilityRatePct: 10.0,     // 10% move threshold triggering halt
  volatilityCooldownMs: 5000,     // 5 second cooldown window
};
