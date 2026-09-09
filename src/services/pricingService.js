const { eventBus, EVENTS } = require('../utils/eventBus');

const INITIAL_PRICES = {
  'AAPL': 227.5,
  'MSFT': 415.2,
  'TSLA': 248.9,
  'NVDA': 131.4,
};

// Static price table initialized with historical values, dynamically updated on trades.
const PRICES = { ...INITIAL_PRICES };

function lastPrice(symbol) {
  return PRICES[symbol] != null ? PRICES[symbol] : null;
}

function updatePrice(symbol, price) {
  PRICES[symbol] = Number(price);
  eventBus.emit(EVENTS.PRICE_UPDATED, {
    symbol,
    price: Number(price),
    timestamp: Date.now(),
  });
  return PRICES[symbol];
}

function symbols() {
  return Object.keys(PRICES);
}

function resetPrices() {
  for (const key of Object.keys(PRICES)) {
    delete PRICES[key];
  }
  Object.assign(PRICES, INITIAL_PRICES);
}

// Update prices when trades execute
eventBus.on(EVENTS.PRICE_UPDATED, ({ symbol, price }) => {
  PRICES[symbol] = Number(price);
});

module.exports = {
  lastPrice,
  updatePrice,
  symbols,
  resetPrices,
  PRICES,
};
