const config = require('../config');
const { eventBus, EVENTS } = require('../utils/eventBus');
const pricing = require('./pricingService');

class CircuitBreakerService {
  constructor(customConfig = {}) {
    this.config = {
      ...config.circuitBreaker,
      ...customConfig,
    };
    // Per symbol state: symbol -> { state: 'CLOSED'|'OPEN'|'HALF_OPEN', referencePrice, trippedAt, tripReason, priceHistory: [{ price, timestamp }] }
    this.states = new Map();

    // Listen to price updates
    this._priceUpdateListener = ({ symbol, price, timestamp }) => {
      this.recordPriceUpdate(symbol, price, timestamp);
    };
    eventBus.on(EVENTS.PRICE_UPDATED, this._priceUpdateListener);
  }

  _getState(symbol) {
    if (!this.states.has(symbol)) {
      const initialPrice = pricing.lastPrice(symbol) || 100;
      this.states.set(symbol, {
        state: 'CLOSED',
        referencePrice: initialPrice,
        trippedAt: null,
        tripReason: null,
        priceHistory: [{ price: initialPrice, timestamp: Date.now() }],
      });
    }
    const symState = this.states.get(symbol);

    // Check automatic cooldown recovery
    if (symState.state === 'OPEN' && symState.trippedAt) {
      const elapsed = Date.now() - symState.trippedAt;
      if (elapsed >= this.config.cooldownMs) {
        symState.state = 'CLOSED';
        symState.trippedAt = null;
        symState.tripReason = null;
        symState.priceHistory = [{ price: symState.referencePrice, timestamp: Date.now() }];
        eventBus.emit(EVENTS.CIRCUIT_BREAKER_RESET, {
          symbol,
          state: 'CLOSED',
          timestamp: Date.now(),
        });
      }
    }

    return symState;
  }

  setReferencePrice(symbol, price) {
    const symState = this._getState(symbol);
    symState.referencePrice = Number(price);
    symState.state = 'CLOSED';
    symState.trippedAt = null;
    symState.tripReason = null;
    symState.priceHistory = [{ price: Number(price), timestamp: Date.now() }];
  }

  getPriceBand(symbol) {
    const symState = this._getState(symbol);
    const refPrice = symState.referencePrice;
    const bandPct = this.config.priceBandPercent;
    const lower = Number((refPrice * (1 - bandPct)).toFixed(4));
    const upper = Number((refPrice * (1 + bandPct)).toFixed(4));
    return { referencePrice: refPrice, lowerBand: lower, upperBand: upper };
  }

  recordPriceUpdate(symbol, price, timestamp = Date.now()) {
    const symState = this._getState(symbol);
    const numPrice = Number(price);

    const windowCutoff = timestamp - this.config.slidingWindowMs;
    symState.priceHistory = symState.priceHistory.filter(p => p.timestamp >= windowCutoff);
    symState.priceHistory.push({ price: numPrice, timestamp });

    if (!this.config.enabled) return;

    // Evaluate volatility in sliding window
    if (symState.priceHistory.length >= 2) {
      let minPrice = Infinity;
      let maxPrice = -Infinity;
      for (const entry of symState.priceHistory) {
        if (entry.price < minPrice) minPrice = entry.price;
        if (entry.price > maxPrice) maxPrice = entry.price;
      }

      if (minPrice > 0) {
        const swing = (maxPrice - minPrice) / minPrice;
        if (swing >= this.config.volatilityThresholdPercent && symState.state !== 'OPEN') {
          this.trip(
            symbol,
            `Volatility spike: ${(swing * 100).toFixed(2)}% price swing in sliding window (${minPrice} to ${maxPrice})`
          );
          return;
        }
      }
    }

    // Update reference price smoothly if not tripped
    symState.referencePrice = numPrice;
  }

  validateOrder(symbol, price) {
    if (!this.config.enabled) return { valid: true };

    const symState = this._getState(symbol);

    // 1. Check if circuit breaker is active / OPEN
    if (symState.state === 'OPEN') {
      return {
        valid: false,
        state: 'OPEN',
        reason: `Circuit breaker active: trading is paused for ${symbol} due to high volatility (${symState.tripReason})`,
      };
    }

    // 2. Check price band
    const { lowerBand, upperBand, referencePrice } = this.getPriceBand(symbol);
    if (price < lowerBand || price > upperBand) {
      return {
        valid: false,
        state: symState.state,
        reason: `Order price ${price} outside price band [${lowerBand}, ${upperBand}] (ref: ${referencePrice}) for ${symbol}`,
      };
    }

    return { valid: true };
  }

  trip(symbol, reason = 'Manual circuit breaker trigger') {
    const symState = this._getState(symbol);
    symState.state = 'OPEN';
    symState.trippedAt = Date.now();
    symState.tripReason = reason;

    eventBus.emit(EVENTS.CIRCUIT_BREAKER_TRIGGERED, {
      symbol,
      state: 'OPEN',
      reason,
      referencePrice: symState.referencePrice,
      timestamp: symState.trippedAt,
    });
  }

  reset(symbol) {
    const symState = this._getState(symbol);
    symState.state = 'CLOSED';
    symState.trippedAt = null;
    symState.tripReason = null;
    symState.priceHistory = [{ price: symState.referencePrice, timestamp: Date.now() }];

    eventBus.emit(EVENTS.CIRCUIT_BREAKER_RESET, {
      symbol,
      state: 'CLOSED',
      timestamp: Date.now(),
    });
  }

  getStatus(symbol) {
    const symState = this._getState(symbol);
    const { lowerBand, upperBand, referencePrice } = this.getPriceBand(symbol);
    return {
      symbol,
      state: symState.state,
      referencePrice,
      lowerBand,
      upperBand,
      trippedAt: symState.trippedAt,
      tripReason: symState.tripReason,
      enabled: this.config.enabled,
    };
  }

  getAllStatuses() {
    const result = {};
    const syms = pricing.symbols();
    for (const sym of syms) {
      result[sym] = this.getStatus(sym);
    }
    for (const [sym] of this.states.entries()) {
      if (!result[sym]) {
        result[sym] = this.getStatus(sym);
      }
    }
    return result;
  }

  clear() {
    this.states.clear();
  }

  destroy() {
    if (this._priceUpdateListener) {
      eventBus.removeListener(EVENTS.PRICE_UPDATED, this._priceUpdateListener);
    }
    this.clear();
  }
}

const circuitBreakerService = new CircuitBreakerService();

module.exports = {
  circuitBreakerService,
  CircuitBreakerService,
};
