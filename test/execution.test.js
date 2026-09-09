const { test } = require('node:test');
const assert = require('node:assert');
const { Order } = require('../src/models/order');
const engine = require('../src/services/executionEngine');
const book = require('../src/models/orderBook');

test('execution engine matches orders and applies circuit breaker', () => {
  book.book.orders.length = 0;
  for (let key in book.book.bySymbol) delete book.book.bySymbol[key];
  engine.circuitBreakers['AAPL'] = null;

  const buy = new Order({ symbol: 'AAPL', side: 'buy', qty: 10, price: 150 });
  const sell = new Order({ symbol: 'AAPL', side: 'sell', qty: 5, price: 140 });
  
  book.add(buy);
  book.add(sell);

  let trades = 0;
  engine.engineEvents.on('trade', () => trades++);
  engine.matchOrders('AAPL');
  
  assert.equal(trades, 1);
  assert.equal(buy.qty, 5);
  assert.equal(buy.status, 'partial');
  assert.equal(sell.qty, 0);
  assert.equal(sell.status, 'executed');

  // Trigger circuit breaker with a 20% price drop (reference price was 150)
  // To get a trade at 120, we need a resting order at 120 and a new order to cross it.
  // The buy order at 150 is still there, let's cancel/remove it first by setting qty to 0.
  buy.qty = 0;
  buy.status = 'executed';
  
  const buy2 = new Order({ symbol: 'AAPL', side: 'buy', qty: 5, price: 120 });
  const sell2 = new Order({ symbol: 'AAPL', side: 'sell', qty: 5, price: 120 });
  book.add(buy2);
  book.add(sell2);
  
  let breakerHalted = false;
  engine.engineEvents.on('circuit_breaker', (d) => { if(d.state==='halted') breakerHalted = true; });
  engine.matchOrders('AAPL');
  
  assert.equal(breakerHalted, true);
  assert.equal(engine.circuitBreakers['AAPL'].isHalted, true);
  assert.equal(sell2.qty, 5); // Should not have executed because of circuit breaker
});
