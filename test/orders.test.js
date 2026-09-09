'use strict';
/**
 * test/orders.test.js — original tests (must keep passing unchanged).
 *
 * The fee test calls the synchronous computeFee shim exported from
 * orderService, which still runs legacyLedgerSync inline. That's fine for
 * the test runner; the shim is not used on the hot acknowledgement path.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { Order } = require('../src/models/order');
const orderService = require('../src/services/orderService');
const pricing = require('../src/services/pricingService');

test('order gets sequential id', () => {
  const o = new Order({ symbol: 'AAPL', side: 'buy', qty: 10, price: 100 });
  assert.match(o.id, /^ORD-\d{6}$/);
  assert.equal(o.status, 'accepted');
});

test('fee uses default bps with legacy rounding', () => {
  const fee = orderService.computeFee(1000, 100);
  assert.equal(fee, 120); // 1000*100*12/10000 = 120
});

test('pricing returns known symbol', () => {
  assert.equal(pricing.lastPrice('AAPL'), 227.5);
  assert.equal(pricing.lastPrice('NOPE'), null);
});
