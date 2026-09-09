const { eventBus, EVENTS } = require('../utils/eventBus');

let tradeSeq = 1;

class SymbolOrderBook {
  constructor(symbol) {
    this.symbol = symbol;
    // Price level maps: price -> Array<Order>
    this.bids = new Map(); // Buy orders: sorted descending by price
    this.asks = new Map(); // Sell orders: sorted ascending by price
    this.lastTradedPrice = null;
  }

  // Returns sorted bid prices (descending)
  getSortedBidPrices() {
    return Array.from(this.bids.keys()).sort((a, b) => b - a);
  }

  // Returns sorted ask prices (ascending)
  getSortedAskPrices() {
    return Array.from(this.asks.keys()).sort((a, b) => a - b);
  }

  // Match and add order into the book
  processOrder(order) {
    const executedTrades = [];

    if (order.side === 'buy') {
      const askPrices = this.getSortedAskPrices();

      for (const askPrice of askPrices) {
        if (order.remainingQty <= 0) break;
        if (askPrice > order.price) break; // Crossing price condition: ask.price <= buy.price

        const askQueue = this.asks.get(askPrice);
        while (askQueue && askQueue.length > 0 && order.remainingQty > 0) {
          const restingAsk = askQueue[0];
          const matchQty = Math.min(order.remainingQty, restingAsk.remainingQty);

          const trade = {
            tradeId: 'TRD-' + String(tradeSeq++).padStart(6, '0'),
            symbol: this.symbol,
            price: restingAsk.price, // Maker price
            qty: matchQty,
            buyOrderId: order.id,
            sellOrderId: restingAsk.id,
            timestamp: new Date().toISOString(),
          };

          order.filledQty += matchQty;
          order.remainingQty -= matchQty;
          order.trades.push(trade);

          restingAsk.filledQty += matchQty;
          restingAsk.remainingQty -= matchQty;
          restingAsk.trades.push(trade);

          if (restingAsk.remainingQty === 0) {
            restingAsk.status = 'filled';
            restingAsk.updatedAt = new Date().toISOString();
            askQueue.shift();
          } else {
            restingAsk.status = 'partially_filled';
            restingAsk.updatedAt = new Date().toISOString();
          }

          this.lastTradedPrice = trade.price;
          executedTrades.push(trade);
        }

        if (askQueue && askQueue.length === 0) {
          this.asks.delete(askPrice);
        }
      }

      if (order.remainingQty === 0) {
        order.status = 'filled';
      } else if (order.filledQty > 0) {
        order.status = 'partially_filled';
        this._addRestingOrder(this.bids, order.price, order);
      } else {
        order.status = 'accepted';
        this._addRestingOrder(this.bids, order.price, order);
      }
    } else if (order.side === 'sell') {
      const bidPrices = this.getSortedBidPrices();

      for (const bidPrice of bidPrices) {
        if (order.remainingQty <= 0) break;
        if (bidPrice < order.price) break; // Crossing price condition: bid.price >= sell.price

        const bidQueue = this.bids.get(bidPrice);
        while (bidQueue && bidQueue.length > 0 && order.remainingQty > 0) {
          const restingBid = bidQueue[0];
          const matchQty = Math.min(order.remainingQty, restingBid.remainingQty);

          const trade = {
            tradeId: 'TRD-' + String(tradeSeq++).padStart(6, '0'),
            symbol: this.symbol,
            price: restingBid.price, // Maker price
            qty: matchQty,
            buyOrderId: restingBid.id,
            sellOrderId: order.id,
            timestamp: new Date().toISOString(),
          };

          order.filledQty += matchQty;
          order.remainingQty -= matchQty;
          order.trades.push(trade);

          restingBid.filledQty += matchQty;
          restingBid.remainingQty -= matchQty;
          restingBid.trades.push(trade);

          if (restingBid.remainingQty === 0) {
            restingBid.status = 'filled';
            restingBid.updatedAt = new Date().toISOString();
            bidQueue.shift();
          } else {
            restingBid.status = 'partially_filled';
            restingBid.updatedAt = new Date().toISOString();
          }

          this.lastTradedPrice = trade.price;
          executedTrades.push(trade);
        }

        if (bidQueue && bidQueue.length === 0) {
          this.bids.delete(bidPrice);
        }
      }

      if (order.remainingQty === 0) {
        order.status = 'filled';
      } else if (order.filledQty > 0) {
        order.status = 'partially_filled';
        this._addRestingOrder(this.asks, order.price, order);
      } else {
        order.status = 'accepted';
        this._addRestingOrder(this.asks, order.price, order);
      }
    }

    order.updatedAt = new Date().toISOString();
    return executedTrades;
  }

  _addRestingOrder(map, price, order) {
    if (!map.has(price)) {
      map.set(price, []);
    }
    map.get(price).push(order);
  }

  cancelOrder(orderId) {
    for (const [price, queue] of this.bids.entries()) {
      const idx = queue.findIndex(o => o.id === orderId);
      if (idx !== -1) {
        const [cancelled] = queue.splice(idx, 1);
        if (queue.length === 0) this.bids.delete(price);
        cancelled.status = 'cancelled';
        cancelled.updatedAt = new Date().toISOString();
        return cancelled;
      }
    }
    for (const [price, queue] of this.asks.entries()) {
      const idx = queue.findIndex(o => o.id === orderId);
      if (idx !== -1) {
        const [cancelled] = queue.splice(idx, 1);
        if (queue.length === 0) this.asks.delete(price);
        cancelled.status = 'cancelled';
        cancelled.updatedAt = new Date().toISOString();
        return cancelled;
      }
    }
    return null;
  }

  getDepth(maxLevels = 10) {
    const bidPrices = this.getSortedBidPrices().slice(0, maxLevels);
    const askPrices = this.getSortedAskPrices().slice(0, maxLevels);

    const bids = bidPrices.map(price => {
      const queue = this.bids.get(price) || [];
      const totalQty = queue.reduce((sum, o) => sum + o.remainingQty, 0);
      return [price, totalQty];
    });

    const asks = askPrices.map(price => {
      const queue = this.asks.get(price) || [];
      const totalQty = queue.reduce((sum, o) => sum + o.remainingQty, 0);
      return [price, totalQty];
    });

    const bestBid = bids.length > 0 ? bids[0][0] : null;
    const bestAsk = asks.length > 0 ? asks[0][0] : null;
    const spread = (bestBid != null && bestAsk != null) ? Number((bestAsk - bestBid).toFixed(6)) : null;

    return {
      symbol: this.symbol,
      bids,
      asks,
      bestBid,
      bestAsk,
      spread,
      lastPrice: this.lastTradedPrice,
      timestamp: Date.now(),
    };
  }

  clear() {
    this.bids.clear();
    this.asks.clear();
    this.lastTradedPrice = null;
  }
}

// Master Order Engine & Shared Mutable Legacy Compatibility
class OrderEngine {
  constructor() {
    this.symbols = new Map(); // symbol -> SymbolOrderBook
    this.allOrders = [];
    this.ordersById = new Map();
    this.executedTrades = [];
  }

  getSymbolBook(symbol) {
    if (!this.symbols.has(symbol)) {
      this.symbols.set(symbol, new SymbolOrderBook(symbol));
    }
    return this.symbols.get(symbol);
  }

  add(order) {
    this.allOrders.push(order);
    this.ordersById.set(order.id, order);

    // Keep legacy book.bySymbol in sync
    if (!book.bySymbol[order.symbol]) {
      book.bySymbol[order.symbol] = [];
    }
    book.bySymbol[order.symbol].push(order);

    const symBook = this.getSymbolBook(order.symbol);
    const trades = symBook.processOrder(order);

    if (trades.length > 0) {
      this.executedTrades.push(...trades);
      eventBus.emit(EVENTS.TRADES_EXECUTED, { symbol: order.symbol, trades, order });
      for (const trade of trades) {
        eventBus.emit(EVENTS.PRICE_UPDATED, { symbol: order.symbol, price: trade.price, timestamp: trade.timestamp });
      }
    }

    eventBus.emit(EVENTS.ORDER_PLACED, order);
    eventBus.emit(EVENTS.BOOK_UPDATED, symBook.getDepth());

    return order;
  }

  find(id) {
    return this.ordersById.get(id) || null;
  }

  all() {
    return this.allOrders;
  }

  getDepth(symbol, maxLevels = 10) {
    return this.getSymbolBook(symbol).getDepth(maxLevels);
  }

  getTrades(symbol = null) {
    if (symbol) {
      return this.executedTrades.filter(t => t.symbol === symbol);
    }
    return this.executedTrades;
  }

  cancelOrder(id) {
    const order = this.find(id);
    if (!order) return null;
    const symBook = this.getSymbolBook(order.symbol);
    const cancelled = symBook.cancelOrder(id);
    if (cancelled) {
      eventBus.emit(EVENTS.BOOK_UPDATED, symBook.getDepth());
    }
    return cancelled;
  }

  clear() {
    this.symbols.clear();
    this.allOrders.length = 0;
    this.ordersById.clear();
    this.executedTrades.length = 0;
    book.orders.length = 0;
    for (const key of Object.keys(book.bySymbol)) {
      delete book.bySymbol[key];
    }
  }
}

const engine = new OrderEngine();

// Legacy shared mutable book object to maintain 100% backward compatibility
const book = {
  orders: engine.allOrders,
  bySymbol: {},
};

function add(order) {
  return engine.add(order);
}

function find(id) {
  return engine.find(id);
}

function all() {
  return engine.all();
}

function resetTradeSeq(start = 1) {
  tradeSeq = start;
}

module.exports = {
  book,
  add,
  find,
  all,
  engine,
  OrderEngine,
  SymbolOrderBook,
  resetTradeSeq,
};
