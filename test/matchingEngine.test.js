const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Order, resetIdSequence } = require('../src/models/order');
const { engine, book, resetTradeSeq } = require('../src/models/orderBook');

beforeEach(() => {
  engine.clear();
  resetIdSequence(1);
  resetTradeSeq(1);
});

test('matching engine: resting orders populate L2 book depth and spread', () => {
  const buy1 = new Order({ symbol: 'AAPL', side: 'buy', qty: 50, price: 220.0 });
  const buy2 = new Order({ symbol: 'AAPL', side: 'buy', qty: 30, price: 220.0 });
  const sell1 = new Order({ symbol: 'AAPL', side: 'sell', qty: 40, price: 230.0 });

  engine.add(buy1);
  engine.add(buy2);
  engine.add(sell1);

  const depth = engine.getDepth('AAPL');
  assert.equal(depth.bestBid, 220.0);
  assert.equal(depth.bestAsk, 230.0);
  assert.equal(depth.spread, 10.0);
  assert.deepEqual(depth.bids, [[220.0, 80]]);
  assert.deepEqual(depth.asks, [[230.0, 40]]);
  assert.equal(buy1.status, 'accepted');
  assert.equal(sell1.status, 'accepted');
});

test('matching engine: incoming buy matches resting sell at maker price', () => {
  const sell = new Order({ symbol: 'AAPL', side: 'sell', qty: 50, price: 225.0 });
  engine.add(sell);

  // Incoming buy with higher limit price matches at resting sell's maker price 225.0
  const buy = new Order({ symbol: 'AAPL', side: 'buy', qty: 50, price: 227.0 });
  engine.add(buy);

  assert.equal(buy.status, 'filled');
  assert.equal(sell.status, 'filled');
  assert.equal(buy.filledQty, 50);
  assert.equal(buy.remainingQty, 0);
  assert.equal(sell.filledQty, 50);
  assert.equal(sell.remainingQty, 0);

  assert.equal(buy.trades.length, 1);
  assert.equal(buy.trades[0].price, 225.0); // maker price
  assert.equal(buy.trades[0].qty, 50);

  const depth = engine.getDepth('AAPL');
  assert.equal(depth.bids.length, 0);
  assert.equal(depth.asks.length, 0);
  assert.equal(depth.lastPrice, 225.0);
});

test('matching engine: partial fill leaves remaining quantity on book', () => {
  const sell = new Order({ symbol: 'MSFT', side: 'sell', qty: 30, price: 400.0 });
  engine.add(sell);

  // Incoming buy for 100 shares at 400.0
  const buy = new Order({ symbol: 'MSFT', side: 'buy', qty: 100, price: 400.0 });
  engine.add(buy);

  assert.equal(sell.status, 'filled');
  assert.equal(buy.status, 'partially_filled');
  assert.equal(buy.filledQty, 30);
  assert.equal(buy.remainingQty, 70);

  const depth = engine.getDepth('MSFT');
  assert.deepEqual(depth.bids, [[400.0, 70]]);
  assert.equal(depth.asks.length, 0);
});

test('matching engine: multi-level sweep in FIFO price-time priority', () => {
  const sell1 = new Order({ symbol: 'TSLA', side: 'sell', qty: 10, price: 200.0 });
  const sell2 = new Order({ symbol: 'TSLA', side: 'sell', qty: 20, price: 200.0 });
  const sell3 = new Order({ symbol: 'TSLA', side: 'sell', qty: 50, price: 205.0 });

  engine.add(sell1);
  engine.add(sell2);
  engine.add(sell3);

  // Buy 40 shares at 205.0 sweeps sell1 (10@200), sell2 (20@200), and partial sell3 (10@205)
  const buy = new Order({ symbol: 'TSLA', side: 'buy', qty: 40, price: 205.0 });
  engine.add(buy);

  assert.equal(buy.status, 'filled');
  assert.equal(buy.trades.length, 3);
  assert.equal(buy.trades[0].qty, 10);
  assert.equal(buy.trades[0].price, 200.0);
  assert.equal(buy.trades[1].qty, 20);
  assert.equal(buy.trades[1].price, 200.0);
  assert.equal(buy.trades[2].qty, 10);
  assert.equal(buy.trades[2].price, 205.0);

  assert.equal(sell1.status, 'filled');
  assert.equal(sell2.status, 'filled');
  assert.equal(sell3.status, 'partially_filled');
  assert.equal(sell3.remainingQty, 40);

  const depth = engine.getDepth('TSLA');
  assert.deepEqual(depth.asks, [[205.0, 40]]);
});

test('matching engine: order cancellation', () => {
  const buy = new Order({ symbol: 'NVDA', side: 'buy', qty: 100, price: 130.0 });
  engine.add(buy);

  const cancelled = engine.cancelOrder(buy.id);
  assert.equal(cancelled.id, buy.id);
  assert.equal(cancelled.status, 'cancelled');

  const depth = engine.getDepth('NVDA');
  assert.equal(depth.bids.length, 0);
});

test('backward compatibility: book.orders and book.bySymbol reflect all orders', () => {
  const o1 = new Order({ symbol: 'AAPL', side: 'buy', qty: 10, price: 220.0 });
  const o2 = new Order({ symbol: 'AAPL', side: 'sell', qty: 10, price: 230.0 });

  engine.add(o1);
  engine.add(o2);

  assert.equal(book.orders.length, 2);
  assert.equal(book.bySymbol['AAPL'].length, 2);
  assert.equal(book.orders[0].id, o1.id);
});
