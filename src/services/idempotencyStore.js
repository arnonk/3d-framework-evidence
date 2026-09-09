/**
 * idempotencyStore.js
 *
 * Keeps a bounded in-memory cache of completed order responses keyed by
 * client-supplied idempotency keys (the `x-client-order-id` request header).
 *
 * Guarantees:
 *   • A key seen a second time within `ttlMs` returns the same body that was
 *     returned on the first call.
 *   • A key seen after `ttlMs` is treated as a fresh request (safe because
 *     the client must have given up by then).
 *   • TTL entries are cleaned up lazily on every `get`/`set` to avoid a
 *     background timer when the process is idle.
 */

const config = require('../config');

// Map<clientOrderId, { result, expiresAt }>
const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.result;
}

function set(key, result) {
  store.set(key, { result, expiresAt: Date.now() + config.idempotencyTtlMs });
  _evict();
}

/** Lazily evict expired entries so the Map doesn't grow unbounded. */
function _evict() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now > v.expiresAt) store.delete(k);
  }
}

/** Exposed for testing. */
function clear() { store.clear(); }
function size()  { return store.size; }

module.exports = { get, set, clear, size };
