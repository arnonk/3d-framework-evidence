const EventEmitter = require('node:events');
const { book, addActive, removeActive } = require('../models/orderBook');

class MatchingEngine extends EventEmitter {
  matchOrder(order) {
    let remainingQty = order.qty;
    const symbol = order.symbol;
    
    if (order.side === 'buy') {
      const asks = book.asks[symbol] || [];
      while (remainingQty > 0 && asks.length > 0 && asks[0].price <= order.price) {
        const match = asks[0];
        const tradeQty = Math.min(remainingQty, match.qty);
        
        remainingQty -= tradeQty;
        match.qty -= tradeQty;
        
        // Emitting trade execution for Task 6
        this.emit('trade', {
          type: 'trade',
          symbol: symbol,
          price: match.price,
          qty: tradeQty,
          time: new Date().toISOString()
        });
        
        if (match.qty === 0) {
          match.status = 'filled';
          removeActive(match);
        }
      }
    } else {
      const bids = book.bids[symbol] || [];
      while (remainingQty > 0 && bids.length > 0 && bids[0].price >= order.price) {
        const match = bids[0];
        const tradeQty = Math.min(remainingQty, match.qty);
        
        remainingQty -= tradeQty;
        match.qty -= tradeQty;
        
        // Emitting trade execution for Task 6
        this.emit('trade', {
          type: 'trade',
          symbol: symbol,
          price: match.price,
          qty: tradeQty,
          time: new Date().toISOString()
        });
        
        if (match.qty === 0) {
          match.status = 'filled';
          removeActive(match);
        }
      }
    }
    
    order.qty = remainingQty;
    if (remainingQty > 0) {
      order.status = 'open';
      addActive(order);
    } else {
      order.status = 'filled';
    }
    
    this.emitBookUpdate(symbol);
  }

  emitBookUpdate(symbol) {
    const bids = (book.bids[symbol] || []).map(o => [o.price, o.qty]);
    const asks = (book.asks[symbol] || []).map(o => [o.price, o.qty]);
    
    // Grouping by price level is common, but basic list of [price, qty] is fine for now as per SPEC
    this.emit('book_update', {
      type: 'book_update',
      symbol: symbol,
      bids: bids,
      asks: asks
    });
  }
}

module.exports = new MatchingEngine();
