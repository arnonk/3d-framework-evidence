// In-memory idempotency cache with atomic promise resolution and payload mismatch detection.

const cache = new Map();
const inFlight = new Map();

function getPayloadFingerprint(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const { symbol, side, qty, price } = payload;
  return JSON.stringify({ symbol, side, qty: Number(qty), price: Number(price) });
}

function processIdempotent(key, payload, fn, cb) {
  if (!key) {
    return fn(cb);
  }

  const fingerprint = getPayloadFingerprint(payload);

  if (cache.has(key)) {
    const cached = cache.get(key);
    if (cached.fingerprint !== fingerprint) {
      const err = new Error('Idempotency key payload mismatch');
      err.statusCode = 422;
      return cb(err);
    }
    return cb(null, cached.result);
  }

  if (inFlight.has(key)) {
    const entry = inFlight.get(key);
    if (entry.fingerprint !== fingerprint) {
      const err = new Error('Idempotency key payload mismatch');
      err.statusCode = 422;
      return cb(err);
    }
    return entry.promise
      .then(result => cb(null, result))
      .catch(err => cb(err));
  }

  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  inFlight.set(key, { fingerprint, promise });

  fn((err, result) => {
    inFlight.delete(key);
    if (err) {
      rejectPromise(err);
      return cb(err);
    }
    cache.set(key, { fingerprint, result });
    resolvePromise(result);
    cb(null, result);
  });
}

function clear() {
  cache.clear();
  inFlight.clear();
}

module.exports = { processIdempotent, getPayloadFingerprint, clear, cache, inFlight };
