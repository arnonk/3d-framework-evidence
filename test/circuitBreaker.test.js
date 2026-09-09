const { test, describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { validateOrder } = require('../src/utils/validate');
const { MockMarketFeed } = require('./mocks/marketFeed');

// Future engine service: circuitBreaker
// When not yet implemented, require may fail or methods won't exist yet
let circuitBreaker;
try {
  circuitBreaker = require('../src/services/circuitBreaker');
} catch (e) {
  circuitBreaker = null;
}

let pricingService;
try {
  pricingService = require('../src/services/pricingService');
} catch (e) {
  pricingService = null;
}

describe('Order Validation & Price-Band Circuit Breakers', () => {

  describe('Order Input Validation', () => {
    it('accepts valid order payload', () => {
      const err = validateOrder({ symbol: 'AAPL', side: 'buy', qty: 10, price: 227.5 });
      assert.strictEqual(err, null);
    });

    it('rejects missing or non-object body', () => {
      assert.strictEqual(validateOrder(null), 'body required');
      assert.strictEqual(validateOrder(undefined), 'body required');
      assert.strictEqual(validateOrder('string'), 'body required');
    });

    it('rejects invalid or missing symbol', () => {
      assert.strictEqual(validateOrder({ side: 'buy', qty: 10, price: 100 }), 'symbol required');
      assert.strictEqual(validateOrder({ symbol: '', side: 'buy', qty: 10, price: 100 }), 'symbol required');
    });

    it('rejects invalid side', () => {
      assert.strictEqual(validateOrder({ symbol: 'AAPL', side: 'hold', qty: 10, price: 100 }), 'side must be buy|sell');
      assert.strictEqual(validateOrder({ symbol: 'AAPL', side: 'BUY', qty: 10, price: 100 }), 'side must be buy|sell');
    });

    it('rejects non-positive or non-finite qty', () => {
      assert.strictEqual(validateOrder({ symbol: 'AAPL', side: 'buy', qty: 0, price: 100 }), 'qty must be positive');
      assert.strictEqual(validateOrder({ symbol: 'AAPL', side: 'buy', qty: -5, price: 100 }), 'qty must be positive');
      assert.strictEqual(validateOrder({ symbol: 'AAPL', side: 'buy', qty: NaN, price: 100 }), 'qty must be positive');
    });

    it('rejects qty exceeding maxOrderQty (10000)', () => {
      assert.strictEqual(validateOrder({ symbol: 'AAPL', side: 'buy', qty: 10001, price: 100 }), 'qty exceeds max');
    });

    it('rejects non-positive price', () => {
      assert.strictEqual(validateOrder({ symbol: 'AAPL', side: 'buy', qty: 10, price: 0 }), 'price must be positive');
      assert.strictEqual(validateOrder({ symbol: 'AAPL', side: 'buy', qty: 10, price: -100 }), 'price must be positive');
    });
  });

  describe('Price-Band Circuit Breaker Calculations & Rules', () => {
    it('calculates +/- 5% price bands around reference price', () => {
      assert.ok(circuitBreaker, 'circuitBreaker module should exist');
      const refPrice = 200.0;
      const bandPct = 5.0;
      const bands = circuitBreaker.calculateBands(refPrice, bandPct);
      
      assert.strictEqual(bands.lower, 190.0); // 200 * (1 - 0.05)
      assert.strictEqual(bands.upper, 210.0); // 200 * (1 + 0.05)
    });

    it('accepts orders within the allowable price band', () => {
      assert.ok(circuitBreaker, 'circuitBreaker module should exist');
      // AAPL reference price is 227.5. +/- 5% is [216.125, 238.875]
      const order = { symbol: 'AAPL', side: 'buy', qty: 10, price: 228.0 };
      const result = circuitBreaker.validateOrderPrice(order);
      assert.strictEqual(result.allowed, true);
    });

    it('rejects buy order priced above the upper price band', () => {
      assert.ok(circuitBreaker, 'circuitBreaker module should exist');
      // AAPL ref: 227.5, upper band: 238.875, order price: 245.00
      const order = { symbol: 'AAPL', side: 'buy', qty: 10, price: 245.0 };
      const result = circuitBreaker.validateOrderPrice(order);
      assert.strictEqual(result.allowed, false);
      assert.match(result.reason, /circuit breaker|upper limit/i);
    });

    it('rejects sell order priced below the lower price band', () => {
      assert.ok(circuitBreaker, 'circuitBreaker module should exist');
      // AAPL ref: 227.5, lower band: 216.125, order price: 200.00
      const order = { symbol: 'AAPL', side: 'sell', qty: 10, price: 200.0 };
      const result = circuitBreaker.validateOrderPrice(order);
      assert.strictEqual(result.allowed, false);
      assert.match(result.reason, /circuit breaker|lower limit/i);
    });

    it('dynamically adapts price bands when market feed updates reference price', () => {
      assert.ok(circuitBreaker, 'circuitBreaker module should exist');
      assert.ok(pricingService, 'pricingService module should exist');

      const feed = new MockMarketFeed({ symbol: 'AAPL', initialPrice: 227.5 });
      
      // Initially price 240 is above upper bound (238.875) -> rejected
      assert.strictEqual(circuitBreaker.validateOrderPrice({ symbol: 'AAPL', side: 'buy', qty: 10, price: 240.0 }).allowed, false);

      // Market feed drifts up to 240.00
      feed.triggerSpike('up', 5.5); // price moves to ~240.01
      pricingService.updatePrice('AAPL', feed.currentPrice);

      // Now price 240 is within band [228.01, 252.01] -> allowed
      assert.strictEqual(circuitBreaker.validateOrderPrice({ symbol: 'AAPL', side: 'buy', qty: 10, price: 240.0 }).allowed, true);
    });

    it('triggers circuit breaker halt upon sudden market volatility spike', () => {
      assert.ok(circuitBreaker, 'circuitBreaker module should exist');
      const feed = new MockMarketFeed({ symbol: 'TSLA', initialPrice: 200.0 });

      // Trigger a 15% volatility flash drop
      const tick = feed.triggerSpike('down', 15.0);
      circuitBreaker.recordPriceTick(tick.symbol, tick.price, tick.timestamp);

      // Circuit breaker enters halted state for symbol
      const isHalted = circuitBreaker.isHalted('TSLA');
      assert.strictEqual(isHalted, true);

      // Orders rejected while halted
      const orderResult = circuitBreaker.validateOrderPrice({ symbol: 'TSLA', side: 'buy', qty: 5, price: 170.0 });
      assert.strictEqual(orderResult.allowed, false);
      assert.match(orderResult.reason, /halted|volatility/i);
    });
  });
});
