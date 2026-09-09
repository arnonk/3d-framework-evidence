/**
 * idempotency.js – in-memory idempotency store.
 *
 * Clients supply an `Idempotency-Key` header with every order POST.
 * On the first request with that key we record the promise; if the same key
 * arrives again (retry on timeout) we wait for the same promise and return
 * the same result, preventing double-execution.
 *
 * Keys expire after `ttlMs` (default 5 minutes) to prevent unbounded growth.
 * Duplicate keys that arrive *after* expiry are treated as new requests.
 */
'use strict';

const config = require('../config');

const TTL_MS = config.idempotencyTtlMs || 5 * 60 * 1000; // 5 minutes

// Map<key, { promise, expiresAt }>
const store = new Map();

/**
 * Execute `fn` exactly once per idempotency key.
 *
 * @param {string|null} key   – the Idempotency-Key header value, or null to skip
 * @param {() => Promise<any>} fn  – the operation to run (must return a Promise)
 * @returns {Promise<{ result: any, cached: boolean }>}
 */
function once(key, fn) {
  if (!key) {
    // No key supplied – just run
    return fn().then(result => ({ result, cached: false }));
  }

  const now = Date.now();

  // Purge expired entries lazily
  for (const [k, entry] of store) {
    if (entry.expiresAt < now) store.delete(k);
  }

  if (store.has(key)) {
    const entry = store.get(key);
    return entry.promise.then(result => ({ result, cached: true }));
  }

  const promise = fn();
  store.set(key, { promise, expiresAt: now + TTL_MS });
  return promise.then(result => ({ result, cached: false }));
}

/** Clear everything (test helper). */
function clear() {
  store.clear();
}

/** Current store size (test / diagnostic helper). */
function size() {
  return store.size;
}

module.exports = { once, clear, size };
