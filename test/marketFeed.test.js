const { test, describe, it } = require('node:test');
const assert = require('node:assert');
const { MockMarketFeed } = require('./mocks/marketFeed');

describe('Deterministic In-Memory Mock Market Feed Generator', () => {
  it('generates deterministic price series given a seed', () => {
    const feed1 = new MockMarketFeed({ symbol: 'AAPL', initialPrice: 227.5, seed: 42 });
    const feed2 = new MockMarketFeed({ symbol: 'AAPL', initialPrice: 227.5, seed: 42 });

    const series1 = feed1.generateSeries(10);
    const series2 = feed2.generateSeries(10);

    assert.strictEqual(series1.length, 10);
    assert.strictEqual(series2.length, 10);
    assert.deepStrictEqual(series1.map(t => t.price), series2.map(t => t.price));
  });

  it('triggers configurable volatility spikes and notifies listeners', () => {
    const feed = new MockMarketFeed({ symbol: 'TSLA', initialPrice: 200.0, seed: 100 });
    const receivedTicks = [];

    const unsubscribe = feed.subscribe(tick => {
      receivedTicks.push(tick);
    });

    // Step 1 normal tick
    const t1 = feed.nextTick();
    assert.strictEqual(t1.isSpike, false);

    // Trigger explicit volatility spike
    const spikeTick = feed.triggerSpike('down', 12.0);
    assert.strictEqual(spikeTick.isSpike, true);
    assert.ok(spikeTick.price < 180.0 && spikeTick.price > 170.0);
    assert.strictEqual(receivedTicks.length, 2);

    unsubscribe();
    feed.nextTick();
    assert.strictEqual(receivedTicks.length, 2); // Unsubscribed
  });

  it('handles scheduled volatility spikes at specific steps', () => {
    const feed = new MockMarketFeed({
      symbol: 'NVDA',
      initialPrice: 130.0,
      seed: 99,
      spikes: [{ step: 3, magnitudePct: 10.0, direction: 'up' }],
    });

    const t1 = feed.nextTick();
    const t2 = feed.nextTick();
    const t3 = feed.nextTick();

    assert.strictEqual(t1.isSpike, false);
    assert.strictEqual(t2.isSpike, false);
    assert.strictEqual(t3.isSpike, true);
    assert.ok(t3.price > 140.0);
  });
});
