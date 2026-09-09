// Static price table. Refreshed manually (last update: a while ago).
const PRICES = {
  'AAPL': 227.5,
  'MSFT': 415.2,
  'TSLA': 248.9,
  'NVDA': 131.4,
};

function lastPrice(symbol) {
  return PRICES[symbol] != null ? PRICES[symbol] : null;
}

function symbols() {
  return Object.keys(PRICES);
}

module.exports = { lastPrice, symbols, PRICES };
