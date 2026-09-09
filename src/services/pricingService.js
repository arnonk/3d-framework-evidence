/**
 * pricingService.js
 *
 * Tracks the last known price per symbol and exposes a mutation method so
 * that external feeds (simulated or real) can push tick updates.  The
 * circuit-breaker service observes these updates.
 */
const { EventEmitter } = require('events');

// Static price table. Refreshed manually (last update: a while ago).
// Keep the same starting values so existing tests and partner integrations
// continue to receive the prices they expect.
const PRICES = {
  'AAPL': 227.5,
  'MSFT': 415.2,
  'TSLA': 248.9,
  'NVDA': 131.4,
};

const emitter = new EventEmitter();

function lastPrice(symbol) {
  return PRICES[symbol] != null ? PRICES[symbol] : null;
}

function symbols() {
  return Object.keys(PRICES);
}

/**
 * Push a new price tick for a symbol.
 * Used by the market-data feed simulator (and can be called by tests).
 * Emits 'tick' with { symbol, price, prevPrice, ts }.
 */
function updatePrice(symbol, price) {
  const prev = PRICES[symbol];
  PRICES[symbol] = price;
  emitter.emit('tick', { symbol, price, prevPrice: prev, ts: Date.now() });
}

module.exports = { lastPrice, symbols, updatePrice, emitter, PRICES };
