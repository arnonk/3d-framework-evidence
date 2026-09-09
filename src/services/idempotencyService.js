const crypto = require('node:crypto');
const config = require('../config');

class IdempotencyService {
  constructor(customConfig = {}) {
    this.config = {
      ...config.idempotency,
      ...customConfig,
    };
    this.cache = new Map(); // key -> { response, paramsHash, createdAt }
    this.inFlight = new Map(); // key -> Promise
  }

  extractKey(req = {}) {
    const headers = req.headers || {};
    const body = req.body || req;

    const headerKey = headers['idempotency-key'] || headers['x-idempotency-key'];
    if (headerKey && typeof headerKey === 'string' && headerKey.trim()) {
      return headerKey.trim();
    }

    if (body && typeof body === 'object') {
      const bodyKey = body.idempotency_key || body.idempotencyKey || body.client_order_id || body.clientOrderId;
      if (bodyKey && typeof bodyKey === 'string' && bodyKey.trim()) {
        return bodyKey.trim();
      }
    }

    return null;
  }

  hashParams(params = {}) {
    const canonical = {
      symbol: String(params.symbol || '').toUpperCase(),
      side: String(params.side || '').toLowerCase(),
      qty: Number(params.qty),
      price: Number(params.price),
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  async execute(key, params, operation) {
    if (!key) {
      return await operation();
    }

    // 1. Check if completed result is cached
    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      const incomingHash = this.hashParams(params);

      // Check TTL
      if (Date.now() - entry.createdAt > this.config.ttlMs) {
        this.cache.delete(key);
      } else {
        if (entry.paramsHash !== incomingHash) {
          const error = new Error('Idempotency key reused with different order parameters');
          error.code = 'IDEMPOTENCY_CONFLICT';
          error.statusCode = 409;
          throw error;
        }
        return {
          isDuplicate: true,
          ...entry.response,
        };
      }
    }

    // 2. Check if identical request is currently in-flight
    if (this.inFlight.has(key)) {
      const existingPromise = this.inFlight.get(key);
      return await existingPromise;
    }

    // 3. First time: create in-flight promise and execute
    let resolveFn;
    let rejectFn;
    const inFlightPromise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    this.inFlight.set(key, inFlightPromise);

    try {
      const result = await operation();
      const entry = {
        response: result,
        paramsHash: this.hashParams(params),
        createdAt: Date.now(),
      };

      this.cache.set(key, entry);

      // Evict oldest if exceeding maxKeys
      if (this.cache.size > this.config.maxKeys) {
        const oldestKey = this.cache.keys().next().value;
        this.cache.delete(oldestKey);
      }

      this.inFlight.delete(key);
      resolveFn(result);
      return result;
    } catch (err) {
      this.inFlight.delete(key);
      rejectFn(err);
      throw err;
    }
  }

  clear() {
    this.cache.clear();
    this.inFlight.clear();
  }
}

const idempotencyService = new IdempotencyService();

module.exports = {
  idempotencyService,
  IdempotencyService,
};
