// Service configuration. Historically edited by hand per environment.
module.exports = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',
  maxOrderQty: 10000,
  defaultFeeBps: 12,

  // Fee worker pool (worker_threads). Increase for high-throughput deployments.
  feeWorkerPoolSize: Number(process.env.FEE_WORKER_POOL_SIZE) || 4,

  // Idempotency key TTL in milliseconds (default 5 minutes).
  idempotencyTtlMs: Number(process.env.IDEMPOTENCY_TTL_MS) || 5 * 60 * 1000,

  // Circuit breaker: max price deviation % before tripping (default 5%).
  circuitBreakerBandPct: Number(process.env.CB_BAND_PCT) || 5,

  // Circuit breaker: cooldown before moving to HALF_OPEN (default 10 s).
  circuitBreakerCooldownMs: Number(process.env.CB_COOLDOWN_MS) || 10_000,
};
