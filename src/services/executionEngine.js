const EventEmitter = require('events');
const engineEvents = new EventEmitter();
const book = require('../models/orderBook');

const circuitBreakers = {};

function getBookOrders(symbol) {
  return book.book.bySymbol[symbol] || [];
}

function matchOrders(symbol) {
  if (circuitBreakers[symbol] && circuitBreakers[symbol].isHalted) {
     if (Date.now() < circuitBreakers[symbol].resumeAt) {
        return; 
     } else {
        circuitBreakers[symbol].isHalted = false; 
        engineEvents.emit('circuit_breaker', { symbol, state: 'resumed' });
     }
  }

  const orders = getBookOrders(symbol);
  // Get active buys (highest price first, then oldest)
  const buys = orders
    .filter(o => o.side === 'buy' && ['accepted', 'partial'].includes(o.status))
    .sort((a, b) => b.price - a.price || a.id.localeCompare(b.id));
  
  // Get active sells (lowest price first, then oldest)
  const sells = orders
    .filter(o => o.side === 'sell' && ['accepted', 'partial'].includes(o.status))
    .sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));

  while (buys.length > 0 && sells.length > 0) {
    const buy = buys[0];
    const sell = sells[0];

    if (buy.price >= sell.price) {
      const olderOrder = (buy.id < sell.id) ? buy : sell;
      const tradePrice = olderOrder.price;

      // Circuit breaker check
      if (circuitBreakers[symbol] && circuitBreakers[symbol].referencePrice) {
         const ref = circuitBreakers[symbol].referencePrice;
         const diff = Math.abs(tradePrice - ref) / ref;
         if (diff > 0.1) {
             circuitBreakers[symbol].isHalted = true;
             circuitBreakers[symbol].resumeAt = Date.now() + 10000;
             engineEvents.emit('circuit_breaker', { symbol, state: 'halted', tradePrice, referencePrice: ref });
             break;
         }
      }

      const tradeQty = Math.min(buy.qty, sell.qty);
      buy.qty -= tradeQty;
      sell.qty -= tradeQty;
      buy.status = buy.qty === 0 ? 'executed' : 'partial';
      sell.status = sell.qty === 0 ? 'executed' : 'partial';

      if (!circuitBreakers[symbol]) circuitBreakers[symbol] = {};
      circuitBreakers[symbol].referencePrice = tradePrice;

      engineEvents.emit('trade', { symbol, price: tradePrice, qty: tradeQty, maker: olderOrder.id, taker: (olderOrder === buy ? sell.id : buy.id) });
      engineEvents.emit('order_update', buy);
      engineEvents.emit('order_update', sell);

      if (buy.qty === 0) buys.shift();
      if (sell.qty === 0) sells.shift();
    } else {
      break;
    }
  }
}

module.exports = {
  matchOrders,
  engineEvents,
  circuitBreakers
};
