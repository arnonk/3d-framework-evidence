const { test } = require('node:test');
const assert = require('node:assert');
const { validateOrder } = require('../src/utils/validate');

test('Validates a correctly formed limit order', () => {
  const err = validateOrder({ symbol: 'AAPL', side: 'buy', qty: 10, price: 150 });
  assert.equal(err, null);
});

test('Reject orders with negative quantity', () => {
  const err = validateOrder({ symbol: 'AAPL', side: 'buy', qty: -10, price: 150 });
  assert.equal(err, 'qty must be positive');
});

test('Reject orders missing price for standard limit processing', () => {
  const err = validateOrder({ symbol: 'AAPL', side: 'buy', qty: 10 });
  assert.equal(err, 'price must be positive');
});

test('Reject orders missing symbol', () => {
  const err = validateOrder({ side: 'buy', qty: 10, price: 150 });
  assert.equal(err, 'symbol required');
});

test('Reject orders with invalid side', () => {
  const err = validateOrder({ symbol: 'AAPL', side: 'hold', qty: 10, price: 150 });
  assert.equal(err, 'side must be buy|sell');
});
