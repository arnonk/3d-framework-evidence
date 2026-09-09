const config = require('../config');
const pricing = require('./pricingService');

const haltedUntil = {};
const tickHistory = {}; // symbol -> [{ price, timestamp }]

function calculateBands(refPrice, bandPct = config.circuitBreakerBandPct) {
  const pct = Number(bandPct) / 100;
  const lower = Number((refPrice * (1 - pct)).toFixed(4));
  const upper = Number((refPrice * (1 + pct)).toFixed(4));
  return { lower, upper };
}

function isHalted(symbol) {
  const until = haltedUntil[symbol];
  if (!until) return false;
  if (Date.now() < until) return true;
  delete haltedUntil[symbol];
  return false;
}

function recordPriceTick(symbol, price, timestamp = Date.now()) {
  if (!tickHistory[symbol]) {
    tickHistory[symbol] = [];
  }
  
  const history = tickHistory[symbol];
  history.push({ price, timestamp });

  // Clean ticks older than 10 seconds
  const cutoff = timestamp - 10000;
  while (history.length > 0 && history[0].timestamp < cutoff) {
    history.shift();
  }

  // Check for volatility spike against baseline tick in window or current reference price
  const refPrice = pricing.lastPrice(symbol);
  const basePrice = history.length >= 2 ? history[0].price : refPrice;

  if (basePrice != null && basePrice > 0) {
    const changePct = Math.abs((price - basePrice) / basePrice) * 100;
    if (changePct >= config.maxVolatilityRatePct) {
      haltedUntil[symbol] = timestamp + config.volatilityCooldownMs;
    }
  }
}

function validateOrderPrice(order) {
  if (isHalted(order.symbol)) {
    return {
      allowed: false,
      reason: `Trading halted for ${order.symbol} due to extreme volatility spike`,
    };
  }

  const refPrice = pricing.lastPrice(order.symbol);
  if (refPrice == null) {
    return { allowed: true };
  }

  const bands = calculateBands(refPrice, config.circuitBreakerBandPct);

  if (order.side === 'buy' && order.price > bands.upper) {
    return {
      allowed: false,
      reason: `Buy price ${order.price} exceeds circuit breaker upper limit ${bands.upper}`,
    };
  }

  if (order.side === 'sell' && order.price < bands.lower) {
    return {
      allowed: false,
      reason: `Sell price ${order.price} breaches circuit breaker lower limit ${bands.lower}`,
    };
  }

  return { allowed: true };
}

function reset() {
  for (const k of Object.keys(haltedUntil)) delete haltedUntil[k];
  for (const k of Object.keys(tickHistory)) delete tickHistory[k];
}

module.exports = {
  calculateBands,
  isHalted,
  recordPriceTick,
  validateOrderPrice,
  reset,
};
