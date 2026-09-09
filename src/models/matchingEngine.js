const EventEmitter = require('node:events');
const book = require('./orderBook');

class MatchingEngine extends EventEmitter {
  constructor() {
    super();
    this.nextTradeId = 1;
    this.trades = [];
  }

  reset() {
    this.nextTradeId = 1;
    this.trades.length = 0;
  }

  processOrder(order) {
    const executedTrades = [];
    const symbolOrders = (book.bySymbol[order.symbol] || []).filter(o => o.id !== order.id);

    if (order.side === 'buy') {
      // Find matching resting sell orders (asks)
      const matchingAsks = symbolOrders
        .filter(o => o.side === 'sell' && o.remainingQty > 0 && o.price <= order.price && o.status !== 'rejected' && o.status !== 'cancelled')
        .sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));

      for (const restingAsk of matchingAsks) {
        if (order.remainingQty <= 0) break;

        const matchQty = Math.min(order.remainingQty, restingAsk.remainingQty);
        const matchPrice = restingAsk.price;

        order.filledQty += matchQty;
        order.remainingQty -= matchQty;
        restingAsk.filledQty += matchQty;
        restingAsk.remainingQty -= matchQty;

        restingAsk.status = restingAsk.remainingQty === 0 ? 'filled' : 'partially_filled';

        const trade = {
          tradeId: 'TRD-' + String(this.nextTradeId++).padStart(6, '0'),
          symbol: order.symbol,
          price: matchPrice,
          qty: matchQty,
          buyOrderId: order.id,
          sellOrderId: restingAsk.id,
          makerOrderId: restingAsk.id,
          takerOrderId: order.id,
          timestamp: Date.now(),
        };

        this.trades.push(trade);
        executedTrades.push(trade);

        this.emit('trade', trade);
        this.emit('order_update', {
          orderId: restingAsk.id,
          symbol: restingAsk.symbol,
          status: restingAsk.status,
          filledQty: restingAsk.filledQty,
          remainingQty: restingAsk.remainingQty,
          price: restingAsk.price,
          timestamp: Date.now(),
        });
      }

      if (order.filledQty === order.qty) {
        order.status = 'filled';
      } else if (order.filledQty > 0) {
        order.status = 'partially_filled';
      } else {
        order.status = 'accepted';
      }

    } else if (order.side === 'sell') {
      // Find matching resting buy orders (bids)
      const matchingBids = symbolOrders
        .filter(o => o.side === 'buy' && o.remainingQty > 0 && o.price >= order.price && o.status !== 'rejected' && o.status !== 'cancelled')
        .sort((a, b) => b.price - a.price || a.id.localeCompare(b.id));

      for (const restingBid of matchingBids) {
        if (order.remainingQty <= 0) break;

        const matchQty = Math.min(order.remainingQty, restingBid.remainingQty);
        const matchPrice = restingBid.price;

        order.filledQty += matchQty;
        order.remainingQty -= matchQty;
        restingBid.filledQty += matchQty;
        restingBid.remainingQty -= matchQty;

        restingBid.status = restingBid.remainingQty === 0 ? 'filled' : 'partially_filled';

        const trade = {
          tradeId: 'TRD-' + String(this.nextTradeId++).padStart(6, '0'),
          symbol: order.symbol,
          price: matchPrice,
          qty: matchQty,
          buyOrderId: restingBid.id,
          sellOrderId: order.id,
          makerOrderId: restingBid.id,
          takerOrderId: order.id,
          timestamp: Date.now(),
        };

        this.trades.push(trade);
        executedTrades.push(trade);

        this.emit('trade', trade);
        this.emit('order_update', {
          orderId: restingBid.id,
          symbol: restingBid.symbol,
          status: restingBid.status,
          filledQty: restingBid.filledQty,
          remainingQty: restingBid.remainingQty,
          price: restingBid.price,
          timestamp: Date.now(),
        });
      }

      if (order.filledQty === order.qty) {
        order.status = 'filled';
      } else if (order.filledQty > 0) {
        order.status = 'partially_filled';
      } else {
        order.status = 'accepted';
      }
    }

    this.emit('order_update', {
      orderId: order.id,
      symbol: order.symbol,
      status: order.status,
      filledQty: order.filledQty,
      remainingQty: order.remainingQty,
      price: order.price,
      timestamp: Date.now(),
    });

    // Emit book update for the order price level
    const depth = book.getDepth(order.symbol);
    const sideLevels = order.side === 'buy' ? depth.bids : depth.asks;
    const currentLevel = sideLevels.find(([p]) => p === order.price);
    const totalQtyAtPrice = currentLevel ? currentLevel[1] : 0;

    this.emit('book_update', {
      symbol: order.symbol,
      side: order.side,
      price: order.price,
      qty: totalQtyAtPrice,
      timestamp: Date.now(),
    });

    return { order, trades: executedTrades };
  }
}

const matchingEngine = new MatchingEngine();
module.exports = { MatchingEngine, matchingEngine };
