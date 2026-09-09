/**
 * Deterministic in-memory Mock Market Feed Generator
 * Supports configurable volatility spikes, seedable PRNG, and event streaming.
 */

class MockMarketFeed {
  constructor(options = {}) {
    this.symbol = options.symbol || 'AAPL';
    this.initialPrice = options.initialPrice !== undefined ? options.initialPrice : 227.5;
    this.currentPrice = this.initialPrice;
    this.volatilityPct = options.volatilityPct !== undefined ? options.volatilityPct : 0.5; // normal tick % change
    this.driftPct = options.driftPct !== undefined ? options.driftPct : 0.0;
    this.seed = options.seed !== undefined ? options.seed : 12345;
    this.stepCount = 0;
    this.listeners = [];
    this.timer = null;
    this.pendingSpikes = options.spikes || []; // [{ step: 5, magnitudePct: 15, direction: 'down' }]
  }

  // Seedable deterministic PRNG (Mulberry32)
  _prng() {
    this.seed |= 0;
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(this.seed ^ (this.seed >>> 15), 1 | this.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Generate next deterministic price tick
  nextTick() {
    this.stepCount++;
    let isSpike = false;
    let priceChangePct = 0;

    // Check if a scheduled spike matches current step
    const scheduledSpike = this.pendingSpikes.find(s => s.step === this.stepCount);
    if (scheduledSpike) {
      isSpike = true;
      const sign = scheduledSpike.direction === 'down' ? -1 : 1;
      priceChangePct = sign * Math.abs(scheduledSpike.magnitudePct);
    } else {
      // Normal Brownian drift + Gaussian-like variation using PRNG
      const rand = (this._prng() - 0.5) * 2; // -1.0 to 1.0
      priceChangePct = this.driftPct + rand * this.volatilityPct;
    }

    const nextPrice = Number((this.currentPrice * (1 + priceChangePct / 100)).toFixed(2));
    this.currentPrice = Math.max(0.01, nextPrice);

    const tick = {
      symbol: this.symbol,
      price: this.currentPrice,
      timestamp: Date.now(),
      step: this.stepCount,
      isSpike,
      changePct: priceChangePct,
    };

    for (const listener of this.listeners) {
      try {
        listener(tick);
      } catch (err) {
        // preserve listener execution
      }
    }

    return tick;
  }

  // Programmatically inject an immediate volatility spike
  triggerSpike(direction = 'down', magnitudePct = 10.0) {
    const sign = direction === 'down' ? -1 : 1;
    const priceChangePct = sign * Math.abs(magnitudePct);
    const nextPrice = Number((this.currentPrice * (1 + priceChangePct / 100)).toFixed(2));
    this.currentPrice = Math.max(0.01, nextPrice);
    this.stepCount++;

    const tick = {
      symbol: this.symbol,
      price: this.currentPrice,
      timestamp: Date.now(),
      step: this.stepCount,
      isSpike: true,
      changePct: priceChangePct,
    };

    for (const listener of this.listeners) {
      try {
        listener(tick);
      } catch (err) {}
    }

    return tick;
  }

  // Generate N deterministic ticks at once
  generateSeries(count = 10) {
    const series = [];
    for (let i = 0; i < count; i++) {
      series.push(this.nextTick());
    }
    return series;
  }

  subscribe(listener) {
    if (typeof listener === 'function') {
      this.listeners.push(listener);
    }
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  start(intervalMs = 100) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.nextTick();
    }, intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reset() {
    this.stop();
    this.currentPrice = this.initialPrice;
    this.stepCount = 0;
    this.listeners = [];
  }
}

module.exports = { MockMarketFeed };
