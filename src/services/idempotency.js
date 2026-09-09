/**
 * idempotency.js — request deduplication for order placement.
 *
 * Clients supply an "Idempotency-Key" header (UUID or any opaque string).
 * On the first call with a given key we store the resolved response.
 * Subsequent calls with the same key return the stored response immediately,
 * preventing double-execution on client retries.
 *
 * Keys expire after TTL_MS (default 24 h) to prevent unbounded memory growth.
 *
 * States:
 *   - 'pending'  : first request is in-flight; concurrent dupes will wait
 *   - 'done'     : first request completed; return cached result
 */
'use strict';

const TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS) || 24 * 60 * 60 * 1000; // 24 h

// key -> { state: 'pending'|'done', result?, error?, waiters: [], expiresAt }
const store = new Map();

/**
 * Wrap an async operation with idempotency.
 *
 * @param {string|null} key   - idempotency key from client; null = no dedup
 * @param {Function}    fn    - async factory that returns the result object
 * @returns {Promise<object>} - { result, alreadyExisted }
 */
async function withIdempotency(key, fn) {
  if (!key) {
    return { result: await fn(), alreadyExisted: false };
  }

  // Prune expired entries lazily.
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt < now) store.delete(k);
  }

  const existing = store.get(key);

  if (existing) {
    if (existing.state === 'done') {
      if (existing.error) throw existing.error;
      return { result: existing.result, alreadyExisted: true };
    }

    // In-flight: wait for the first request to finish.
    return new Promise((resolve, reject) => {
      existing.waiters.push({ resolve, reject });
    });
  }

  // First request with this key.
  const entry = {
    state: 'pending',
    result: undefined,
    error: undefined,
    waiters: [],
    expiresAt: now + TTL_MS,
  };
  store.set(key, entry);

  try {
    const result = await fn();
    entry.state = 'done';
    entry.result = result;
    entry.waiters.forEach((w) => w.resolve({ result, alreadyExisted: true }));
    entry.waiters = [];
    return { result, alreadyExisted: false };
  } catch (err) {
    entry.state = 'done';
    entry.error = err;
    entry.waiters.forEach((w) => w.reject(err));
    entry.waiters = [];
    // Remove on error so the client can retry with a new key or same key.
    store.delete(key);
    throw err;
  }
}

/** Exposed for testing only. */
function _clear() {
  store.clear();
}

/** Current number of tracked keys (for monitoring). */
function size() {
  return store.size;
}

module.exports = { withIdempotency, size, _clear };
