// Price table with dynamic updates and reference price lookup.
const PRICES = {
  'AAPL': 227.5,
  'MSFT': 415.2,
  'TSLA': 248.9,
  'NVDA': 131.4,
};

const defaultPrices = { ...PRICES };

function lastPrice(symbol) {
  return PRICES[symbol] != null ? PRICES[symbol] : null;
}

function updatePrice(symbol, price) {
  if (typeof price === 'number' && price > 0) {
    PRICES[symbol] = price;
  }
  return PRICES[symbol];
}

function symbols() {
  return Object.keys(PRICES);
}

function reset() {
  for (const k of Object.keys(PRICES)) delete PRICES[k];
  Object.assign(PRICES, defaultPrices);
}

module.exports = { lastPrice, updatePrice, symbols, reset, PRICES };
