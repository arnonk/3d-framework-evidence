const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

// The circuit breaker isn't implemented yet, but we write the test assuming it will be.
// We'll mock the module structure it should have if it fails to load, so the test runs
// and fails gracefully instead of crashing node.
let circuitBreaker;
try {
  circuitBreaker = require('../src/services/circuitBreaker');
} catch (e) {
  circuitBreaker = {
    isHalted: () => false,
    recordPrice: () => {},
    reset: () => {}
  };
}

describe('Price-Band Circuit Breaker', () => {
  beforeEach(() => {
    if (circuitBreaker.reset) circuitBreaker.reset();
  });

  test('Halts trading when price exceeds upper band (+10%)', () => {
    const symbol = 'AAPL';
    const basePrice = 150;
    circuitBreaker.recordPrice(symbol, basePrice);
    
    assert.equal(circuitBreaker.isHalted(symbol), false);
    
    // Spike by 15% (threshold is assumed to be 10%)
    circuitBreaker.recordPrice(symbol, basePrice * 1.15);
    
    // Engine should halt trading for this symbol due to upward volatility
    assert.equal(circuitBreaker.isHalted(symbol), true, 'Trading should be halted on +15% spike');
  });

  test('Halts trading when price drops below lower band (-10%)', () => {
    const symbol = 'MSFT';
    const basePrice = 200;
    circuitBreaker.recordPrice(symbol, basePrice);
    
    // Drop by 15%
    circuitBreaker.recordPrice(symbol, basePrice * 0.85);
    
    // Engine should halt trading for this symbol due to downward volatility
    assert.equal(circuitBreaker.isHalted(symbol), true, 'Trading should be halted on -15% drop');
  });

  test('Allows normal price fluctuations within the band', () => {
    const symbol = 'NVDA';
    const basePrice = 100;
    circuitBreaker.recordPrice(symbol, basePrice);
    
    // Normal fluctuation of 5%
    circuitBreaker.recordPrice(symbol, basePrice * 1.05);
    assert.equal(circuitBreaker.isHalted(symbol), false);
    
    circuitBreaker.recordPrice(symbol, basePrice * 0.95);
    assert.equal(circuitBreaker.isHalted(symbol), false);
  });
});
