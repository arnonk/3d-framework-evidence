const { test } = require('node:test');
const assert = require('node:assert');
const orderService = require('../src/services/orderService');

test('placeOrder is idempotent', (t, done) => {
  const reqBody = { symbol: 'MSFT', side: 'buy', qty: 10, price: 400 };
  const idempotencyKey = 'idemp-12345';
  
  orderService.placeOrder(reqBody, idempotencyKey, (err1, order1) => {
    assert.ifError(err1);
    
    // Call again with same key
    orderService.placeOrder(reqBody, idempotencyKey, (err2, order2) => {
      assert.ifError(err2);
      assert.equal(order1.id, order2.id); // Should be the exact same order
      done();
    });
  });
});
