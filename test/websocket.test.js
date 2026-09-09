const { test, describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../src/app');
const book = require('../src/models/orderBook');

// Helper to start the server (including websocket handler when implemented)
let wsService;
try {
  wsService = require('../src/services/websocketService');
} catch (e) {
  wsService = null;
}

describe('WebSocket Streaming & Real-Time Trade Notifications Integration Tests', () => {
  let server;
  let baseUrl;
  let wsUrl;

  before(async () => {
    await new Promise(resolve => {
      server = http.createServer(app);
      if (wsService && typeof wsService.attach === 'function') {
        wsService.attach(server);
      }
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        wsUrl = `ws://127.0.0.1:${port}/ws`;
        resolve();
      });
    });
  });

  after(async () => {
    if (wsService && typeof wsService.close === 'function') {
      await wsService.close();
    }
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    if (book && Array.isArray(book.orders)) {
      book.orders.length = 0;
    }
    if (book && book.bySymbol) {
      for (const k of Object.keys(book.bySymbol)) delete book.bySymbol[k];
    }
  });

  function createClient() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const messages = [];

      ws.onmessage = (event) => {
        try {
          messages.push(JSON.parse(event.data));
        } catch (e) {
          messages.push(event.data);
        }
      };

      ws.onopen = () => resolve({ ws, messages });
      ws.onerror = (err) => reject(err);
    });
  }

  function waitForMessage(messages, predicate, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const found = messages.find(predicate);
        if (found) {
          clearInterval(interval);
          return resolve(found);
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error(`Timeout waiting for WebSocket message. Received: ${JSON.stringify(messages)}`));
        }
      }, 20);
    });
  }

  it('connects and responds to ping with pong heartbeat', async () => {
    assert.ok(wsService, 'websocketService must be implemented');
    const { ws, messages } = await createClient();

    ws.send(JSON.stringify({ action: 'ping' }));

    const pong = await waitForMessage(messages, m => m.type === 'pong');
    assert.strictEqual(pong.type, 'pong');
    assert.ok(pong.timestamp);
    ws.close();
  });

  it('subscribes to orderbook channel and receives snapshot and confirmation', async () => {
    assert.ok(wsService, 'websocketService must be implemented');
    const { ws, messages } = await createClient();

    ws.send(JSON.stringify({ action: 'subscribe', channel: 'orderbook', symbol: 'AAPL' }));

    const subAck = await waitForMessage(messages, m => m.type === 'subscribed' && m.channel === 'orderbook');
    assert.strictEqual(subAck.symbol, 'AAPL');

    const snapshot = await waitForMessage(messages, m => m.type === 'snapshot' && m.channel === 'orderbook');
    assert.strictEqual(snapshot.symbol, 'AAPL');
    assert.ok(Array.isArray(snapshot.bids));
    assert.ok(Array.isArray(snapshot.asks));
    ws.close();
  });

  it('broadcasts L2 book_update delta when a new resting order is placed', async () => {
    assert.ok(wsService, 'websocketService must be implemented');
    const { ws, messages } = await createClient();

    ws.send(JSON.stringify({ action: 'subscribe', channel: 'orderbook', symbol: 'AAPL' }));
    await waitForMessage(messages, m => m.type === 'snapshot');

    // Place a resting limit buy order below market
    await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL', side: 'buy', qty: 25, price: 226.0 }),
    });

    const update = await waitForMessage(messages, m => m.type === 'book_update' && m.price === 226.0);
    assert.strictEqual(update.symbol, 'AAPL');
    assert.strictEqual(update.side, 'buy');
    assert.strictEqual(update.qty, 25);
    ws.close();
  });

  it('broadcasts real-time trade execution event when crossing orders match', async () => {
    assert.ok(wsService, 'websocketService must be implemented');
    const { ws, messages } = await createClient();

    ws.send(JSON.stringify({ action: 'subscribe', channel: 'trades', symbol: 'AAPL' }));
    await waitForMessage(messages, m => m.type === 'subscribed' && m.channel === 'trades');

    // 1. Place resting sell order at 227.5
    const sellRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL', side: 'sell', qty: 50, price: 227.5 }),
    });
    const sellData = await sellRes.json();

    // 2. Place aggressive matching buy order at 227.5
    const buyRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL', side: 'buy', qty: 50, price: 227.5 }),
    });
    const buyData = await buyRes.json();

    // 3. Verify WebSocket received trade execution
    const tradeMsg = await waitForMessage(messages, m => m.type === 'trade' && m.channel === 'trades');
    assert.ok(tradeMsg.data);
    assert.strictEqual(tradeMsg.data.symbol, 'AAPL');
    assert.strictEqual(tradeMsg.data.price, 227.5);
    assert.strictEqual(tradeMsg.data.qty, 50);
    assert.strictEqual(tradeMsg.data.makerOrderId, sellData.order_id);
    assert.strictEqual(tradeMsg.data.takerOrderId, buyData.order_id);
    ws.close();
  });

  it('broadcasts order_update lifecycle event when order is filled', async () => {
    assert.ok(wsService, 'websocketService must be implemented');
    const { ws, messages } = await createClient();

    ws.send(JSON.stringify({ action: 'subscribe', channel: 'orders', symbol: 'AAPL' }));
    await waitForMessage(messages, m => m.type === 'subscribed' && m.channel === 'orders');

    // Place matching orders
    await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL', side: 'sell', qty: 10, price: 227.5 }),
    });

    const buyRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL', side: 'buy', qty: 10, price: 227.5 }),
    });
    const buyData = await buyRes.json();

    const orderUpdate = await waitForMessage(messages, m => m.type === 'order_update' && m.data.orderId === buyData.order_id);
    assert.strictEqual(orderUpdate.data.status, 'filled');
    assert.strictEqual(orderUpdate.data.filledQty, 10);
    assert.strictEqual(orderUpdate.data.remainingQty, 0);
    ws.close();
  });
});
