const HALT_THRESHOLD = 0.10; // 10%

const basePrices = {};
const halted = new Set();

function recordPrice(symbol, price) {
  if (!basePrices[symbol]) {
    basePrices[symbol] = price;
    return;
  }
  
  const base = basePrices[symbol];
  const change = Math.abs(price - base) / base;
  
  if (change > HALT_THRESHOLD) {
    halted.add(symbol);
  }
}

function isHalted(symbol) {
  return halted.has(symbol);
}

function reset() {
  for (const key in basePrices) delete basePrices[key];
  halted.clear();
}

module.exports = { recordPrice, isHalted, reset, config: { thresholdPct: HALT_THRESHOLD } };
