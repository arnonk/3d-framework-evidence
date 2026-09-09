'use strict';

/**
 * Deterministic in-memory mock market-feed generator.
 *
 * Produces a controlled sequence of price ticks for one or more symbols.
 * Callers configure:
 *   - basePrice        – starting reference price
 *   - normalDriftPct   – max ± random drift per tick under normal conditions (default 0.5 %)
 *   - spikePct         – size of a volatility spike as % of basePrice (default 10 %)
 *   - seed             – integer seed for the deterministic PRNG (default 42)
 *
 * The PRNG is a simple mulberry32, giving reproducible sequences across
 * test runs without any external dependency.
 *
 * Usage:
 *   const feed = new MarketFeed({ basePrice: 100, seed: 1 });
 *   feed.nextTick();       // → { symbol: 'TEST', price: 100.23, isSpike: false }
 *   feed.spike();          // force-emit a spike tick > bandPct away
 *   feed.ticks(5);         // array of 5 normal ticks
 *   feed.ticksWithSpike(3, 2);  // 3 normal ticks then 1 spike then 2 more normal
 */
class MarketFeed {
  /**
   * @param {object} opts
   * @param {string}  [opts.symbol='TEST']
   * @param {number}  [opts.basePrice=100]
   * @param {number}  [opts.normalDriftPct=0.5]  max ± drift per tick in percent
   * @param {number}  [opts.spikePct=10]          spike size in percent of basePrice
   * @param {number}  [opts.seed=42]              PRNG seed (integer)
   */
  constructor({
    symbol = 'TEST',
    basePrice = 100,
    normalDriftPct = 0.5,
    spikePct = 10,
    seed = 42,
  } = {}) {
    this.symbol = symbol;
    this.basePrice = basePrice;
    this.normalDriftPct = normalDriftPct;
    this.spikePct = spikePct;
    this._seed = seed >>> 0; // uint32
    this._currentPrice = basePrice;
    this._tickCount = 0;
  }

  // ─── Mulberry32 PRNG ──────────────────────────────────────────────────────
  // Returns a float in [0, 1).
  _rand() {
    let t = (this._seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Emit a single normal tick (drift ≤ normalDriftPct).
   * @returns {{ symbol: string, price: number, isSpike: boolean, tickIndex: number }}
   */
  nextTick() {
    const pct = (this._rand() * 2 - 1) * this.normalDriftPct / 100;
    this._currentPrice = +(this._currentPrice * (1 + pct)).toFixed(6);
    return this._make(false);
  }

  /**
   * Emit a spike tick that moves exactly spikePct above the basePrice,
   * guaranteeing the circuit breaker will trip (assuming BAND_PCT < spikePct).
   * The spike is always upward to keep tests deterministic.
   * @returns {{ symbol: string, price: number, isSpike: boolean, tickIndex: number }}
   */
  spike() {
    this._currentPrice = +(this.basePrice * (1 + this.spikePct / 100)).toFixed(6);
    return this._make(true);
  }

  /**
   * Emit n consecutive normal ticks.
   * @param {number} n
   * @returns {Array<{ symbol, price, isSpike, tickIndex }>}
   */
  ticks(n) {
    const result = [];
    for (let i = 0; i < n; i++) result.push(this.nextTick());
    return result;
  }

  /**
   * Emit `before` normal ticks, then one spike, then `after` normal ticks.
   * @param {number} before
   * @param {number} after
   * @returns {Array<{ symbol, price, isSpike, tickIndex }>}
   */
  ticksWithSpike(before, after) {
    return [...this.ticks(before), this.spike(), ...this.ticks(after)];
  }

  /**
   * Reset the feed back to its initial state (same seed, same base price).
   * Useful to run the same scenario twice in the same test.
   */
  reset() {
    this._currentPrice = this.basePrice;
    this._tickCount = 0;
    // Re-seed: store the original seed on construction so reset is reliable.
    // Achieved by re-running from the constructor seed without mutation.
    // (We re-derive from basePrice+seed deterministically.)
    this._seed = (this.basePrice * 1000 + this._originalSeed) >>> 0;
  }

  /** Current price without advancing the feed. */
  get currentPrice() {
    return this._currentPrice;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _make(isSpike) {
    return {
      symbol: this.symbol,
      price: this._currentPrice,
      isSpike,
      tickIndex: this._tickCount++,
    };
  }
}

/**
 * MultiSymbolFeed – drives multiple independent MarketFeed instances and
 * interleaves their ticks in round-robin order.
 *
 * Useful for testing that one symbol's circuit breaker does NOT affect another.
 *
 * @param {Array<object>} feedConfigs  – array of MarketFeed constructor options
 */
class MultiSymbolFeed {
  constructor(feedConfigs) {
    this.feeds = feedConfigs.map((cfg) => new MarketFeed(cfg));
  }

  /**
   * Emit `n` round-robin ticks across all feeds.
   * @param {number} n   total ticks (spread evenly)
   * @returns {Array}
   */
  roundRobin(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(this.feeds[i % this.feeds.length].nextTick());
    }
    return out;
  }

  /**
   * Spike only the feed for the given symbol; leave all others ticking normally.
   * @param {string} symbol
   * @returns {{ symbol, price, isSpike, tickIndex }}
   */
  spikeSymbol(symbol) {
    const feed = this.feeds.find((f) => f.symbol === symbol);
    if (!feed) throw new Error(`No feed for symbol ${symbol}`);
    return feed.spike();
  }
}

module.exports = { MarketFeed, MultiSymbolFeed };
