'use strict';

/**
 * Unit tests – Price-band circuit breaker (FR-6, NFR-4)
 *
 * Tests the circuitBreaker service module in isolation.
 * ALL tests in this file WILL FAIL until T-05 (circuitBreaker.js) is
 * implemented, because the module does not yet exist.
 *
 * The MarketFeed helper is used to produce deterministic price sequences,
 * guaranteeing that spike and normal-tick behaviour is reproducible.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { MarketFeed, MultiSymbolFeed } = require('./helpers/marketFeed');

// The module under test – does not exist yet (will fail on require).
// Wrapped in a lazy loader so the describe blocks can be parsed even when
// the module is absent; individual tests will throw "MODULE_NOT_FOUND".
let cb;
function loadCb() {
  if (!cb) cb = require('../src/services/circuitBreaker');
  return cb;
}

// Also need pricingService to feed prices through the pipeline.
let pricing;
function loadPricing() {
  if (!pricing) pricing = require('../src/services/pricingService');
  return pricing;
}

// Reset breaker state between tests to prevent bleed-through.
// After T-05, circuitBreaker should expose a reset() or _resetAll() for tests.
function resetAll() {
  const breaker = loadCb();
  if (typeof breaker._resetAll === 'function') {
    breaker._resetAll();
  } else {
    // Manually close all known symbols used in tests.
    ['AAPL', 'TSLA', 'MSFT', 'NVDA', 'SYM-A', 'SYM-B', 'TEST'].forEach((s) => {
      if (typeof breaker.reset === 'function') breaker.reset(s);
    });
  }
}

beforeEach(resetAll);
afterEach(resetAll);

// ─────────────────────────────────────────────────────────────────────────────

describe('circuitBreaker – module contract', () => {
  test('module exports evaluate, isOpen, reset, all', () => {
    const breaker = loadCb();
    assert.equal(typeof breaker.evaluate, 'function', 'evaluate must be exported');
    assert.equal(typeof breaker.isOpen, 'function', 'isOpen must be exported');
    assert.equal(typeof breaker.reset, 'function', 'reset must be exported');
    assert.equal(typeof breaker.all, 'function', 'all must be exported');
  });

  test('breaker is initially closed for any symbol', () => {
    const breaker = loadCb();
    assert.equal(breaker.isOpen('AAPL'), false);
    assert.equal(breaker.isOpen('TSLA'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('circuitBreaker – normal ticks do NOT trip the breaker', () => {
  test('50 normal ticks within ±0.5% keep the breaker closed', () => {
    const breaker = loadCb();
    const feed = new MarketFeed({ symbol: 'AAPL', basePrice: 227.5, normalDriftPct: 0.5, seed: 1 });

    // Establish reference price
    const ref = feed.nextTick();
    breaker.evaluate(ref.symbol, ref.price);

    for (const tick of feed.ticks(49)) {
      breaker.evaluate(tick.symbol, tick.price);
    }
    assert.equal(breaker.isOpen('AAPL'), false,
      'breaker must remain closed after 50 normal ticks');
  });

  test('price exactly at band boundary does NOT trip (strict >)', () => {
    // BAND_PCT default = 5 %. A move of exactly 5.0 % must NOT trip.
    const breaker = loadCb();
    const basePrice = 100;
    breaker.evaluate('AAPL', basePrice); // set reference
    breaker.evaluate('AAPL', basePrice * 1.05); // exactly 5 %
    assert.equal(breaker.isOpen('AAPL'), false,
      'move of exactly BAND_PCT must NOT trip');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('circuitBreaker – spike trips the breaker', () => {
  test('a spike of 8 % trips the breaker (BAND_PCT=5)', () => {
    const breaker = loadCb();
    const feed = new MarketFeed({ symbol: 'AAPL', basePrice: 100, spikePct: 8, seed: 42 });

    const ref = feed.nextTick(); // near 100
    breaker.evaluate(ref.symbol, ref.price); // establish reference

    assert.equal(breaker.isOpen('AAPL'), false, 'should be closed before spike');

    const spike = feed.spike();
    breaker.evaluate(spike.symbol, spike.price);

    assert.equal(breaker.isOpen('AAPL'), true, 'breaker must open after 8 % spike');
  });

  test('price move of 5.001 % trips the breaker', () => {
    const breaker = loadCb();
    breaker.evaluate('TSLA', 100);
    breaker.evaluate('TSLA', 105.001);
    assert.equal(breaker.isOpen('TSLA'), true);
  });

  test('evaluate returns { tripped: true } when the breaker trips', () => {
    const breaker = loadCb();
    breaker.evaluate('MSFT', 100); // reference
    const result = breaker.evaluate('MSFT', 120); // 20 % spike
    assert.equal(typeof result, 'object', 'evaluate must return an object');
    assert.equal(result.tripped, true, 'result.tripped must be true after trip');
  });

  test('evaluate returns { tripped: false } on normal ticks', () => {
    const breaker = loadCb();
    breaker.evaluate('NVDA', 131);
    const result = breaker.evaluate('NVDA', 131.5); // ~0.38 % move
    assert.equal(result.tripped, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('circuitBreaker – manual reset', () => {
  test('reset() closes an open breaker', () => {
    const breaker = loadCb();
    breaker.evaluate('AAPL', 100);
    breaker.evaluate('AAPL', 120); // trip
    assert.equal(breaker.isOpen('AAPL'), true);

    breaker.reset('AAPL');
    assert.equal(breaker.isOpen('AAPL'), false, 'breaker must be closed after reset');
  });

  test('reset() returns true when breaker was open', () => {
    const breaker = loadCb();
    breaker.evaluate('TSLA', 100);
    breaker.evaluate('TSLA', 115); // trip
    const wasOpen = breaker.reset('TSLA');
    assert.equal(wasOpen, true);
  });

  test('reset() returns false when breaker was already closed', () => {
    const breaker = loadCb();
    const wasOpen = breaker.reset('AAPL'); // was never open
    assert.equal(wasOpen, false);
  });

  test('orders are accepted again after manual reset', () => {
    // This test verifies that a reset truly clears the open flag,
    // not just that reset() returns the right value.
    const breaker = loadCb();
    breaker.evaluate('MSFT', 100);
    breaker.evaluate('MSFT', 200); // trip
    breaker.reset('MSFT');

    // Now set a new reference with a sane price and tick normally
    breaker.evaluate('MSFT', 200); // new reference after reset
    breaker.evaluate('MSFT', 201); // tiny move
    assert.equal(breaker.isOpen('MSFT'), false,
      'breaker must stay closed after reset + small tick');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('circuitBreaker – symbol independence (risk constraint)', () => {
  test('tripping TSLA does NOT affect AAPL', () => {
    const breaker = loadCb();
    const msf = new MultiSymbolFeed([
      { symbol: 'AAPL', basePrice: 227, normalDriftPct: 0.3, seed: 1 },
      { symbol: 'TSLA', basePrice: 248, spikePct: 20, seed: 2 },
    ]);

    // Feed 4 normal round-robin ticks to establish references
    msf.roundRobin(4).forEach((t) => breaker.evaluate(t.symbol, t.price));
    assert.equal(breaker.isOpen('AAPL'), false);
    assert.equal(breaker.isOpen('TSLA'), false);

    // Spike only TSLA
    const spike = msf.spikeSymbol('TSLA');
    breaker.evaluate(spike.symbol, spike.price);

    assert.equal(breaker.isOpen('TSLA'), true, 'TSLA should be open');
    assert.equal(breaker.isOpen('AAPL'), false, 'AAPL must NOT be affected by TSLA spike');
  });

  test('each symbol has independent reference price', () => {
    const breaker = loadCb();
    breaker.evaluate('SYM-A', 100);
    breaker.evaluate('SYM-B', 200);

    // SYM-A spike (> 5 % of 100)
    breaker.evaluate('SYM-A', 110);
    assert.equal(breaker.isOpen('SYM-A'), true);

    // SYM-B should still be fine with a small move
    breaker.evaluate('SYM-B', 201);
    assert.equal(breaker.isOpen('SYM-B'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('circuitBreaker – all() endpoint data (FR-6.5)', () => {
  test('all() returns an object keyed by symbol', () => {
    const breaker = loadCb();
    breaker.evaluate('AAPL', 227);
    const result = breaker.all();
    assert.equal(typeof result, 'object');
    assert.ok('AAPL' in result, 'AAPL must appear in all()');
  });

  test('closed breaker has state="closed" and tripped_at=null', () => {
    const breaker = loadCb();
    breaker.evaluate('AAPL', 100);
    const entry = breaker.all()['AAPL'];
    assert.equal(entry.state, 'closed');
    assert.equal(entry.tripped_at, null);
    assert.ok(entry.reference_price != null, 'reference_price must be set');
  });

  test('open breaker has state="open" and ISO tripped_at', () => {
    const breaker = loadCb();
    breaker.evaluate('TSLA', 100);
    breaker.evaluate('TSLA', 120); // trip
    const entry = breaker.all()['TSLA'];
    assert.equal(entry.state, 'open');
    assert.ok(typeof entry.tripped_at === 'string', 'tripped_at must be an ISO string');
    assert.ok(!isNaN(Date.parse(entry.tripped_at)), 'tripped_at must be valid ISO-8601');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('circuitBreaker – EventEmitter events (FR-6.6)', () => {
  test('emits "trip" event when breaker opens', (t, done) => {
    const breaker = loadCb();
    breaker.once('trip', (evt) => {
      try {
        assert.equal(evt.symbol, 'AAPL');
        assert.equal(evt.state, 'open');
        assert.ok(typeof evt.reference_price === 'number');
        assert.ok(typeof evt.current_price === 'number');
        assert.ok(typeof evt.band_pct === 'number');
        assert.ok(typeof evt.ts === 'number');
        done();
      } catch (err) {
        done(err);
      }
    });
    breaker.evaluate('AAPL', 100);
    breaker.evaluate('AAPL', 120); // trip
  });

  test('emits "reset" event on manual reset', (t, done) => {
    const breaker = loadCb();
    breaker.evaluate('MSFT', 100);
    breaker.evaluate('MSFT', 130); // trip first
    breaker.once('reset', (evt) => {
      try {
        assert.equal(evt.symbol, 'MSFT');
        assert.equal(evt.state, 'closed');
        done();
      } catch (err) {
        done(err);
      }
    });
    breaker.reset('MSFT');
  });

  test('no "trip" event emitted for normal ticks', (t, done) => {
    const breaker = loadCb();
    let tripped = false;
    breaker.once('trip', () => { tripped = true; });
    breaker.evaluate('NVDA', 131);
    breaker.evaluate('NVDA', 131.5); // tiny move
    // Give any async event a chance to fire
    setImmediate(() => {
      assert.equal(tripped, false, '"trip" must not fire for normal ticks');
      done();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('circuitBreaker – pricingService integration (FR-7.1)', () => {
  test('pricingService.setPrice feeds circuitBreaker.evaluate', () => {
    // After T-05, setPrice must call circuitBreaker.evaluate internally.
    // We verify the side-effect: after a large setPrice move, the breaker opens.
    const breaker = loadCb();
    const priceService = loadPricing();

    if (typeof priceService.setPrice !== 'function') {
      // setPrice not yet implemented – expected to fail
      assert.fail('pricingService.setPrice is not implemented (T-05/T-07 pending)');
    }

    priceService.setPrice('AAPL', 100); // reference
    assert.equal(breaker.isOpen('AAPL'), false);

    priceService.setPrice('AAPL', 115); // 15 % spike
    assert.equal(breaker.isOpen('AAPL'), true,
      'setPrice must trigger circuitBreaker evaluation');
  });
});
