'use strict';

/**
 * Integration tests – WebSocket trade notifications (FR-1.3, FR-5, FR-6.6, §3.3)
 *
 * Tests the full WebSocket stack: connect → snapshot → subscribe → events.
 * ALL tests in this file WILL FAIL until T-08/T-09/T-10 are implemented
 * because the wsServer module does not yet exist.
 *
 * Uses WsCollector (test/helpers/testUtils.js) to buffer WS messages and
 * await specific event types with a timeout.
 * Uses MarketFeed to produce deterministic price sequences for CB tests.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { request, WsCollector, startServer, stopServer } = require('./helpers/testUtils');
const { MarketFeed } = require('./helpers/marketFeed');

let server;
let wsServerModule; // may be undefined until T-08

before(async () => {
  const app = require('../src/app');
  try {
    wsServerModule = require('../src/ws/wsServer');
  } catch {
    // wsServer not yet implemented – tests will fail individually
    wsServerModule = null;
  }
  server = await startServer(app, wsServerModule);
});

after(async () => {
  await stopServer(server);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assertWsServerExists() {
  if (!wsServerModule) {
    assert.fail('src/ws/wsServer.js does not exist (T-08 pending)');
  }
}

async function placeOrder(body) {
  return request(server, { method: 'POST', path: '/api/orders', body });
}

async function pushPrice(symbol, price) {
  return request(server, { method: 'POST', path: '/api/prices', body: { symbol, price } });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('WebSocket – connection and snapshot (FR-5.1)', () => {
  test('server accepts WebSocket connections at /ws', async () => {
    assertWsServerExists();
    const ws = new WsCollector(server);
    await ws.connected();
    // If connected without error, the path is valid
    ws.close();
  });

  test('server sends book_snapshot immediately on connect', async () => {
    assertWsServerExists();
    const ws = new WsCollector(server);
    await ws.connected();

    const snapshot = await ws.waitFor('book_snapshot', 2000);
    assert.equal(snapshot.type, 'book_snapshot');
    assert.ok(Array.isArray(snapshot.bids), 'bids must be an array');
    assert.ok(Array.isArray(snapshot.asks), 'asks must be an array');
    assert.ok(typeof snapshot.ts === 'number', 'ts must be a number (ms epoch)');

    ws.close();
  });

  test('book_snapshot symbol field is "*" when not subscribed to a specific symbol', async () => {
    assertWsServerExists();
    const ws = new WsCollector(server);
    await ws.connected();
    const snapshot = await ws.waitFor('book_snapshot', 2000);
    assert.equal(snapshot.symbol, '*',
      'initial snapshot must have symbol="*" (all symbols)');
    ws.close();
  });

  test('subscribe to a specific symbol triggers a symbol-scoped book_snapshot', async () => {
    assertWsServerExists();
    const ws = new WsCollector(server);
    await ws.connected();
    await ws.waitFor('book_snapshot', 2000); // discard initial wildcard snapshot

    ws.send({ type: 'subscribe', symbol: 'AAPL' });
    const snapshot = await ws.waitFor('book_snapshot', 2000);
    assert.equal(snapshot.symbol, 'AAPL',
      'symbol-specific snapshot must carry the subscribed symbol');
    ws.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('WebSocket – trade_execution on order placement (FR-1.3)', () => {
  test('placing an order emits trade_execution to wildcard subscriber', async () => {
    assertWsServerExists();
    const ws = new WsCollector(server);
    await ws.connected();
    await ws.waitFor('book_snapshot', 2000); // discard snapshot

    const orderRes = await placeOrder({ symbol: 'MSFT', side: 'buy', qty: 10, price: 415 });
    assert.equal(orderRes.status, 201);
    const orderId = orderRes.body.order_id;

    const exec = await ws.waitFor('trade_execution', 3000);
    assert.equal(exec.type, 'trade_execution');
    assert.equal(exec.order_id, orderId, 'trade_execution must carry the new order_id');
    assert.equal(exec.symbol, 'MSFT');
    assert.equal(exec.side, 'buy');
    assert.equal(exec.qty, 10);
    assert.equal(exec.price, 415);
    assert.equal(typeof exec.fee, 'number');
    assert.equal(exec.status, 'accepted');
    assert.ok(typeof exec.ts === 'number');

    ws.close();
  });

  test('trade_execution is only delivered to subscribers of the relevant symbol', async () => {
    assertWsServerExists();

    // ws1 subscribes to AAPL; ws2 subscribes to NVDA
    const ws1 = new WsCollector(server);
    const ws2 = new WsCollector(server);
    await Promise.all([ws1.connected(), ws2.connected()]);

    // Discard initial snapshots
    await ws1.waitFor('book_snapshot', 2000);
    await ws2.waitFor('book_snapshot', 2000);

    ws1.send({ type: 'subscribe', symbol: 'AAPL' });
    ws2.send({ type: 'subscribe', symbol: 'NVDA' });

    // Discard symbol snapshots
    await ws1.waitFor('book_snapshot', 2000);
    await ws2.waitFor('book_snapshot', 2000);

    // Place an AAPL order
    const orderRes = await placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, price: 227 });
    assert.equal(orderRes.status, 201);

    // ws1 must receive trade_execution for AAPL
    const exec = await ws1.waitFor('trade_execution', 3000);
    assert.equal(exec.symbol, 'AAPL');

    // ws2 must NOT have received any trade_execution for AAPL
    const nvdaEvents = ws2.drain('trade_execution');
    const leakedAaplExec = nvdaEvents.filter((e) => e.symbol === 'AAPL');
    assert.equal(leakedAaplExec.length, 0,
      'AAPL trade_execution must not leak to NVDA subscriber');

    ws1.close();
    ws2.close();
  });

  test('trade_execution is also delivered to wildcard (*) subscriber', async () => {
    assertWsServerExists();
    const ws = new WsCollector(server);
    await ws.connected();
    await ws.waitFor('book_snapshot', 2000);
    // Don't subscribe to anything – stay on wildcard

    await placeOrder({ symbol: 'TSLA', side: 'sell', qty: 2, price: 248 });

    const exec = await ws.waitFor('trade_execution', 3000);
    assert.equal(exec.symbol, 'TSLA');
    ws.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('WebSocket – book_update on order placement (FR-5.2)', () => {
  test('placing an order emits book_update with action="add"', async () => {
    assertWsServerExists();
    const ws = new WsCollector(server);
    await ws.connected();
    await ws.waitFor('book_snapshot', 2000);

    await placeOrder({ symbol: 'AAPL', side: 'buy', qty: 50, price: 226 });

    const update = await ws.waitFor('book_update', 3000);
    assert.equal(update.type, 'book_update');
    assert.equal(update.symbol, 'AAPL');
    assert.equal(update.side, 'buy');
    assert.equal(update.action, 'add');
    assert.equal(update.qty, 50);
    assert.equal(update.price, 226);
    assert.ok(typeof update.ts === 'number');

    ws.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('WebSocket – circuit_breaker events (FR-6.6)', () => {
  test('tripping a circuit breaker broadcasts circuit_breaker event to symbol subscribers', async () => {
    assertWsServerExists();

    const feed = new MarketFeed({ symbol: 'TSLA', basePrice: 248, spikePct: 10, seed: 77 });
    const ws = new WsCollector(server);
    await ws.connected();
    await ws.waitFor('book_snapshot', 2000);

    ws.send({ type: 'subscribe', symbol: 'TSLA' });
    await ws.waitFor('book_snapshot', 2000); // symbol snapshot

    // Establish reference price
    const refTick = feed.nextTick();
    await pushPrice(refTick.symbol, refTick.price);

    // Spike price to trigger breaker
    const spikeTick = feed.spike();
    await pushPrice(spikeTick.symbol, spikeTick.price);

    const cbEvent = await ws.waitFor('circuit_breaker', 3000);
    assert.equal(cbEvent.type, 'circuit_breaker');
    assert.equal(cbEvent.symbol, 'TSLA');
    assert.equal(cbEvent.state, 'open');
    assert.ok(typeof cbEvent.reference_price === 'number');
    assert.ok(typeof cbEvent.current_price === 'number');
    assert.ok(typeof cbEvent.band_pct === 'number');
    assert.ok(typeof cbEvent.ts === 'number');

    ws.close();
  });

  test('circuit_breaker event is NOT sent to unrelated symbol subscribers', async () => {
    assertWsServerExists();

    const ws = new WsCollector(server);
    await ws.connected();
    await ws.waitFor('book_snapshot', 2000);

    // Subscribe only to AAPL
    ws.send({ type: 'subscribe', symbol: 'AAPL' });
    await ws.waitFor('book_snapshot', 2000);

    // Trip MSFT breaker (not AAPL)
    await pushPrice('MSFT', 100);
    await pushPrice('MSFT', 200); // 100 % spike

    // Give server time to broadcast
    await new Promise((r) => setTimeout(r, 200));

    const cbEvents = ws.drain('circuit_breaker');
    const msftLeaks = cbEvents.filter((e) => e.symbol === 'MSFT');
    assert.equal(msftLeaks.length, 0,
      'MSFT circuit_breaker must not leak to AAPL subscriber');

    ws.close();
  });

  test('subscribing to a symbol with an already-open breaker gets immediate circuit_breaker event (FR-5.3)', async () => {
    assertWsServerExists();

    // Trip the NVDA breaker before the client subscribes
    await pushPrice('NVDA', 100);
    await pushPrice('NVDA', 200); // 100 % spike → breaker open

    const ws = new WsCollector(server);
    await ws.connected();
    await ws.waitFor('book_snapshot', 2000);

    ws.send({ type: 'subscribe', symbol: 'NVDA' });
    // The server must immediately send the open circuit_breaker state
    const cbEvent = await ws.waitFor('circuit_breaker', 2000);
    assert.equal(cbEvent.symbol, 'NVDA');
    assert.equal(cbEvent.state, 'open');

    ws.close();
  });

  test('manual breaker reset broadcasts circuit_breaker event with state="closed"', async () => {
    assertWsServerExists();

    // Trip the breaker
    await pushPrice('AAPL', 100);
    await pushPrice('AAPL', 115); // 15 % spike

    const ws = new WsCollector(server);
    await ws.connected();
    await ws.waitFor('book_snapshot', 2000);
    ws.send({ type: 'subscribe', symbol: 'AAPL' });
    await ws.waitFor('book_snapshot', 2000);

    // Drain any initial circuit_breaker event (breaker already open)
    ws.drain('circuit_breaker');

    // Reset via REST
    const resetRes = await request(server, {
      method: 'DELETE',
      path: '/api/circuit-breakers/AAPL',
    });
    assert.equal(resetRes.status, 200, `expected 200 from DELETE, got ${resetRes.status}`);

    const cbEvent = await ws.waitFor('circuit_breaker', 3000);
    assert.equal(cbEvent.state, 'closed', 'reset must broadcast state="closed"');

    ws.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('WebSocket – protocol messages (§3.3.1)', () => {
  test('ping receives pong with ts field', async () => {
    assertWsServerExists();
    const ws = new WsCollector(server);
    await ws.connected();
    await ws.waitFor('book_snapshot', 2000);

    ws.send({ type: 'ping' });
    const pong = await ws.waitFor('pong', 2000);
    assert.equal(pong.type, 'pong');
    assert.ok(typeof pong.ts === 'number');

    ws.close();
  });

  test('unknown message type receives error response', async () => {
    assertWsServerExists();
    const ws = new WsCollector(server);
    await ws.connected();
    await ws.waitFor('book_snapshot', 2000);

    ws.send({ type: 'warp_speed_engage' });
    const errMsg = await ws.waitFor('error', 2000);
    assert.equal(errMsg.type, 'error');
    assert.ok(typeof errMsg.message === 'string');

    ws.close();
  });

  test('unsubscribe stops delivery of events for that symbol', async () => {
    assertWsServerExists();
    const ws = new WsCollector(server);
    await ws.connected();
    await ws.waitFor('book_snapshot', 2000);

    ws.send({ type: 'subscribe', symbol: 'AAPL' });
    await ws.waitFor('book_snapshot', 2000);

    ws.send({ type: 'unsubscribe', symbol: 'AAPL' });

    // Give server time to process unsubscribe
    await new Promise((r) => setTimeout(r, 100));

    // Now place an AAPL order
    await placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, price: 227 });

    // Wait briefly; no trade_execution must arrive for AAPL
    await new Promise((r) => setTimeout(r, 300));
    const events = ws.drain('trade_execution').filter((e) => e.symbol === 'AAPL');
    assert.equal(events.length, 0,
      'must not receive AAPL events after unsubscribe');

    ws.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('WebSocket – connectionCount() (FR-4.1)', () => {
  test('wsServer.connectionCount() reflects open connections', async () => {
    assertWsServerExists();
    const before = wsServerModule.connectionCount();

    const ws1 = new WsCollector(server);
    const ws2 = new WsCollector(server);
    await Promise.all([ws1.connected(), ws2.connected()]);

    const during = wsServerModule.connectionCount();
    assert.ok(during >= before + 2,
      `connectionCount should increase by 2 (was ${before}, is ${during})`);

    ws1.close();
    ws2.close();

    // Give server time to register closures
    await new Promise((r) => setTimeout(r, 200));
    const after = wsServerModule.connectionCount();
    assert.ok(after <= before,
      `connectionCount should return to baseline after close (expected ≤${before}, got ${after})`);
  });
});
