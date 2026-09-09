'use strict';

/**
 * Unit tests – Order validation (FR-1.5, NFR-5)
 *
 * Tests the validation layer in isolation (no server, no DB).
 * These tests WILL PASS against the existing code for the rules that already
 * exist, and WILL FAIL for the new constraints added by the spec (e.g.
 * idempotency_key length, price must be finite positive).
 *
 * All tests that target NEW behaviour required by SPEC.md are marked with
 * a comment: // [FAILS UNTIL IMPLEMENTED]
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateOrder } = require('../src/utils/validate');

// Helper: a fully-valid order body.
function valid(overrides = {}) {
  return {
    symbol: 'AAPL',
    side: 'buy',
    qty: 100,
    price: 227.5,
    ...overrides,
  };
}

describe('validateOrder – existing rules (must remain passing)', () => {
  test('accepts a fully valid order', () => {
    assert.equal(validateOrder(valid()), null);
  });

  test('rejects missing body', () => {
    const err = validateOrder(null);
    assert.ok(err, 'expected an error string');
    assert.equal(typeof err, 'string');
  });

  test('rejects missing symbol', () => {
    const err = validateOrder(valid({ symbol: undefined }));
    assert.ok(err);
    assert.match(err, /symbol/i);
  });

  test('rejects non-string symbol', () => {
    assert.ok(validateOrder(valid({ symbol: 42 })));
  });

  test('rejects invalid side value', () => {
    assert.ok(validateOrder(valid({ side: 'LONG' })));
    assert.ok(validateOrder(valid({ side: '' })));
  });

  test('accepts side=buy and side=sell', () => {
    assert.equal(validateOrder(valid({ side: 'buy' })), null);
    assert.equal(validateOrder(valid({ side: 'sell' })), null);
  });

  test('rejects qty=0', () => {
    assert.ok(validateOrder(valid({ qty: 0 })));
  });

  test('rejects negative qty', () => {
    assert.ok(validateOrder(valid({ qty: -1 })));
  });

  test('rejects non-finite qty', () => {
    assert.ok(validateOrder(valid({ qty: Infinity })));
    assert.ok(validateOrder(valid({ qty: NaN })));
  });

  test('rejects qty exceeding maxOrderQty (10000)', () => {
    assert.ok(validateOrder(valid({ qty: 10001 })));
    assert.ok(validateOrder(valid({ qty: 99999 })));
  });

  test('accepts qty exactly at maxOrderQty boundary', () => {
    assert.equal(validateOrder(valid({ qty: 10000 })), null);
  });

  test('rejects price=0', () => {
    assert.ok(validateOrder(valid({ price: 0 })));
  });

  test('rejects negative price', () => {
    assert.ok(validateOrder(valid({ price: -1 })));
  });

  test('rejects non-finite price', () => {
    assert.ok(validateOrder(valid({ price: Infinity })));
    assert.ok(validateOrder(valid({ price: NaN })));
  });
});

describe('validateOrder – new spec rules (FAILS UNTIL IMPLEMENTED)', () => {
  // FR-1.2: idempotency_key must be ≤ 128 chars if supplied.
  test('rejects idempotency_key longer than 128 chars', () => { // [FAILS UNTIL IMPLEMENTED]
    const longKey = 'x'.repeat(129);
    const err = validateOrder(valid({ idempotency_key: longKey }));
    assert.ok(err, 'expected validation error for overlong idempotency_key');
    assert.match(err, /idempotency_key/i);
  });

  test('accepts idempotency_key of exactly 128 chars', () => { // [FAILS UNTIL IMPLEMENTED]
    const key128 = 'k'.repeat(128);
    assert.equal(validateOrder(valid({ idempotency_key: key128 })), null);
  });

  test('accepts order with no idempotency_key (optional field)', () => {
    // idempotency_key is optional – absence must not cause a validation error
    assert.equal(validateOrder(valid()), null);
  });

  test('rejects idempotency_key that is not a string', () => { // [FAILS UNTIL IMPLEMENTED]
    const err = validateOrder(valid({ idempotency_key: 12345 }));
    assert.ok(err, 'expected validation error for non-string idempotency_key');
  });
});

describe('validateOrder – fee formula sanity (FR-1.4)', () => {
  // The fee formula must be preserved exactly:
  // Math.floor(qty * price * bps / 10000 + 0.4999)
  // with defaultFeeBps = 12
  //
  // These tests call computeFee directly once it exists. They will fail until
  // the async refactor in T-03 exposes a synchronous equivalent or the test
  // helper awaits the promise.

  test('fee formula: 1000 shares at $100 with 12 bps = 120', () => { // [FAILS UNTIL IMPLEMENTED - computeFee must be async]
    const orderService = require('../src/services/orderService');
    // After T-03, computeFee returns a Promise; we must await it.
    // Until then this will either throw or return wrong value.
    const feeOrPromise = orderService.computeFee(1000, 100);
    if (feeOrPromise && typeof feeOrPromise.then === 'function') {
      return feeOrPromise.then((fee) => assert.equal(fee, 120));
    }
    assert.equal(feeOrPromise, 120);
  });

  test('fee formula: rounding half-down 1 share at $1 = 0', () => { // [FAILS UNTIL IMPLEMENTED - computeFee must be async]
    const orderService = require('../src/services/orderService');
    const feeOrPromise = orderService.computeFee(1, 1);
    if (feeOrPromise && typeof feeOrPromise.then === 'function') {
      // 1*1*12/10000 = 0.0012, floor(0.0012 + 0.4999) = floor(0.5011) = 0
      return feeOrPromise.then((fee) => assert.equal(fee, 0));
    }
    assert.equal(feeOrPromise, 0);
  });

  test('fee formula: rounding preserves historical half-down behaviour', () => { // [FAILS UNTIL IMPLEMENTED - computeFee must be async]
    // At exactly the rounding threshold: qty * price * 12/10000 = 0.5
    // That means qty * price = 10000/12 ≈ 833.33…
    // Let's use qty=10, price=83.333 → 10*83.333*12/10000 = 0.999996, floor(0.999996+0.4999)=floor(1.499896)=1
    const orderService = require('../src/services/orderService');
    const feeOrPromise = orderService.computeFee(10, 83.333);
    if (feeOrPromise && typeof feeOrPromise.then === 'function') {
      return feeOrPromise.then((fee) => assert.equal(fee, 1));
    }
    assert.equal(feeOrPromise, 1);
  });
});
