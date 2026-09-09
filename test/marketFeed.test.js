'use strict';

/**
 * Unit tests for the mock MarketFeed helper itself.
 * These must pass even before the engine is implemented because they only
 * exercise test infrastructure.
 *
 * SPEC references: FR-6.2 (price-band definition drives spike sizing)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { MarketFeed, MultiSymbolFeed } = require('./helpers/marketFeed');

describe('MarketFeed – determinism', () => {
  test('same seed produces identical sequence', () => {
    const a = new MarketFeed({ basePrice: 100, seed: 7 });
    const b = new MarketFeed({ basePrice: 100, seed: 7 });
    const ta = a.ticks(10).map((t) => t.price);
    const tb = b.ticks(10).map((t) => t.price);
    assert.deepEqual(ta, tb, 'sequences must be byte-identical for the same seed');
  });

  test('different seeds produce different sequences', () => {
    const a = new MarketFeed({ basePrice: 100, seed: 1 });
    const b = new MarketFeed({ basePrice: 100, seed: 2 });
    const ta = a.ticks(5).map((t) => t.price);
    const tb = b.ticks(5).map((t) => t.price);
    assert.notDeepEqual(ta, tb);
  });

  test('tickIndex increments monotonically', () => {
    const feed = new MarketFeed({ basePrice: 50, seed: 3 });
    const ts = feed.ticks(5);
    ts.forEach((t, i) => assert.equal(t.tickIndex, i));
  });
});

describe('MarketFeed – normal ticks stay within band', () => {
  test('all normal ticks stay within ±normalDriftPct of the current price', () => {
    const normalDriftPct = 0.5;
    const feed = new MarketFeed({ basePrice: 200, normalDriftPct, seed: 42 });
    let prev = feed.currentPrice;
    for (const tick of feed.ticks(200)) {
      const movePct = Math.abs(tick.price - prev) / prev * 100;
      assert.ok(
        movePct <= normalDriftPct + 1e-9,
        `normal tick moved ${movePct.toFixed(4)} % (limit ${normalDriftPct} %)`
      );
      prev = tick.price;
    }
  });

  test('no normal tick is flagged as a spike', () => {
    const feed = new MarketFeed({ seed: 99 });
    const allNormal = feed.ticks(50).every((t) => !t.isSpike);
    assert.ok(allNormal);
  });
});

describe('MarketFeed – spike behaviour', () => {
  test('spike tick is flagged isSpike=true', () => {
    const feed = new MarketFeed({ basePrice: 100, spikePct: 10 });
    const t = feed.spike();
    assert.equal(t.isSpike, true);
  });

  test('spike moves price by exactly spikePct above basePrice', () => {
    const basePrice = 100;
    const spikePct = 10;
    const feed = new MarketFeed({ basePrice, spikePct });
    const t = feed.spike();
    const expected = basePrice * (1 + spikePct / 100);
    assert.ok(
      Math.abs(t.price - expected) < 1e-6,
      `spike price ${t.price} ≠ expected ${expected}`
    );
  });

  test('spike price exceeds 5 % BAND_PCT (circuit-breaker trigger)', () => {
    const BAND_PCT = 5;
    const feed = new MarketFeed({ basePrice: 248.9, spikePct: 8 });
    feed.ticks(1); // establish a near-base current price
    const t = feed.spike();
    const movePct = Math.abs(t.price - feed.basePrice) / feed.basePrice * 100;
    assert.ok(
      movePct > BAND_PCT,
      `spike move ${movePct.toFixed(2)} % must exceed BAND_PCT=${BAND_PCT}`
    );
  });

  test('ticksWithSpike places spike at the right position', () => {
    const feed = new MarketFeed({ basePrice: 100, spikePct: 15, seed: 5 });
    const sequence = feed.ticksWithSpike(3, 2);
    assert.equal(sequence.length, 6, '3 normal + 1 spike + 2 normal = 6 ticks');
    assert.equal(sequence[3].isSpike, true, 'spike must be at index 3');
    assert.ok(!sequence[0].isSpike);
    assert.ok(!sequence[1].isSpike);
    assert.ok(!sequence[2].isSpike);
    assert.ok(!sequence[4].isSpike);
    assert.ok(!sequence[5].isSpike);
  });
});

describe('MarketFeed – symbol metadata', () => {
  test('each tick carries the configured symbol', () => {
    const feed = new MarketFeed({ symbol: 'TSLA', basePrice: 248.9 });
    feed.ticks(5).forEach((t) => assert.equal(t.symbol, 'TSLA'));
    assert.equal(feed.spike().symbol, 'TSLA');
  });
});

describe('MultiSymbolFeed', () => {
  test('round-robin interleaves symbols correctly', () => {
    const msf = new MultiSymbolFeed([
      { symbol: 'AAPL', basePrice: 227, seed: 1 },
      { symbol: 'MSFT', basePrice: 415, seed: 2 },
    ]);
    const ticks = msf.roundRobin(6);
    // Positions 0,2,4 → AAPL ; positions 1,3,5 → MSFT
    [0, 2, 4].forEach((i) => assert.equal(ticks[i].symbol, 'AAPL'));
    [1, 3, 5].forEach((i) => assert.equal(ticks[i].symbol, 'MSFT'));
  });

  test('spikeSymbol only affects the targeted symbol', () => {
    const msf = new MultiSymbolFeed([
      { symbol: 'AAPL', basePrice: 227, seed: 10 },
      { symbol: 'TSLA', basePrice: 248, seed: 11 },
    ]);
    // Normal ticks to establish reference
    msf.roundRobin(4);
    const spike = msf.spikeSymbol('TSLA');
    assert.equal(spike.symbol, 'TSLA');
    assert.equal(spike.isSpike, true);
    // AAPL feed's currentPrice must NOT have been changed by the TSLA spike
    const aaplFeed = msf.feeds.find((f) => f.symbol === 'AAPL');
    const movePct = Math.abs(aaplFeed.currentPrice - aaplFeed.basePrice) / aaplFeed.basePrice * 100;
    assert.ok(movePct < 2, 'AAPL should not be spiked when TSLA spikes');
  });

  test('throws on unknown symbol spike', () => {
    const msf = new MultiSymbolFeed([{ symbol: 'NVDA', basePrice: 131 }]);
    assert.throws(() => msf.spikeSymbol('UNKNOWN'), /No feed for symbol/);
  });
});
