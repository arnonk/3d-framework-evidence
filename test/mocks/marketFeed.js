const EventEmitter = require('node:events');

/**
 * A deterministic in-memory mock market-feed generator.
 * Used for testing order matching and circuit breakers without relying on a live feed.
 */
class MockMarketFeed extends EventEmitter {
  constructor() {
    super();
    this.prices = {};
  }

  // Set the initial baseline price for a symbol
  setBasePrice(symbol, price) {
    this.prices[symbol] = price;
    this.emit('price_update', { symbol, price });
  }

  // Generate a deterministic volatility spike
  triggerVolatilitySpike(symbol, percentage, ticks = 5) {
    let currentPrice = this.prices[symbol] || 100;
    const step = (currentPrice * percentage) / ticks;
    
    for (let i = 1; i <= ticks; i++) {
      currentPrice += step;
      this.prices[symbol] = currentPrice;
      this.emit('price_update', { symbol, price: currentPrice });
    }
  }

  // Generate a deterministic order book update
  updateOrderBook(symbol, bids, asks) {
    this.emit('book_update', { symbol, bids, asks });
  }
}

module.exports = new MockMarketFeed();
