/**
 * Deterministic Mock Market Feed Generator
 * Provides reproducible price streams and configurable volatility spikes for testing.
 */

class Mulberry32PRNG {
  constructor(seed = 123456) {
    this.seed = seed;
  }

  next() {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Returns number in range [min, max]
  range(min, max) {
    return min + (max - min) * this.next();
  }
}

class MockMarketFeed {
  constructor(options = {}) {
    this.seed = options.seed || 42;
    this.prng = new Mulberry32PRNG(this.seed);
    this.prices = {
      AAPL: 227.5,
      MSFT: 415.2,
      TSLA: 248.9,
      NVDA: 131.4,
      ...(options.initialPrices || {}),
    };
    this.volatility = options.volatility || 0.002; // 0.2% standard tick volatility
  }

  getPrice(symbol) {
    return this.prices[symbol] || 100.0;
  }

  setPrice(symbol, price) {
    this.prices[symbol] = Number(price);
    return this.prices[symbol];
  }

  // Generates next price tick with standard Gaussian-approximated random walk
  tick(symbol, customVolatility) {
    const current = this.getPrice(symbol);
    const vol = customVolatility != null ? customVolatility : this.volatility;
    // Box-Muller transform for normal distribution
    const u1 = Math.max(1e-10, this.prng.next());
    const u2 = this.prng.next();
    const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

    const deltaPct = z * vol;
    const newPrice = Number((current * (1 + deltaPct)).toFixed(2));
    this.prices[symbol] = Math.max(0.01, newPrice);
    return {
      symbol,
      price: this.prices[symbol],
      previousPrice: current,
      deltaPct: Number((deltaPct * 100).toFixed(3)),
      timestamp: Date.now(),
    };
  }

  // Triggers an immediate volatility spike of jumpPct (e.g. +0.15 for +15%, -0.20 for -20%)
  spike(symbol, jumpPct = 0.15) {
    const current = this.getPrice(symbol);
    const newPrice = Number((current * (1 + jumpPct)).toFixed(2));
    this.prices[symbol] = Math.max(0.01, newPrice);
    return {
      symbol,
      price: this.prices[symbol],
      previousPrice: current,
      deltaPct: Number((jumpPct * 100).toFixed(3)),
      isSpike: true,
      timestamp: Date.now(),
    };
  }

  // Generates synthetic orders around current market price
  generateOrder(symbol, side = null, qty = 10, spreadOffset = 0.005) {
    const price = this.getPrice(symbol);
    const orderSide = side || (this.prng.next() > 0.5 ? 'buy' : 'sell');
    let orderPrice;

    if (orderSide === 'buy') {
      orderPrice = Number((price * (1 - spreadOffset * this.prng.range(0.2, 1.0))).toFixed(2));
    } else {
      orderPrice = Number((price * (1 + spreadOffset * this.prng.range(0.2, 1.0))).toFixed(2));
    }

    return {
      symbol,
      side: orderSide,
      qty,
      price: orderPrice,
    };
  }

  // Simulates a burst of ticks
  generateTicks(symbol, count = 10, vol = null) {
    const ticks = [];
    for (let i = 0; i < count; i++) {
      ticks.push(this.tick(symbol, vol));
    }
    return ticks;
  }
}

module.exports = { MockMarketFeed, Mulberry32PRNG };
