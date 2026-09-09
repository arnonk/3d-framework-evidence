const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocket } = require('ws');
const app = require('../src/app');
const { wsService } = require('../src/services/wsService');
const orderService = require('../src/services/orderService');
const { engine } = require('../src/models/orderBook');
const { circuitBreakerService } = require('../src/services/circuitBreakerService');
const { resetIdSequence } = require('../src/models/order');

let server;
let serverPort;

before(async () => {
  server = http.createServer(app);
  wsService.init(server, '/ws');
  await new Promise(resolve => {
    server.listen(0, () => {
      serverPort = server.address().port;
      resolve();
    });
  });
});

after(async () => {
  wsService.close();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  engine.clear();
  circuitBreakerService.clear();
  circuitBreakerService.setReferencePrice('AAPL', 227.5);
  resetIdSequence(1);
});

function connectClient(port = serverPort) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);

    const handler = data => {
      try {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch (err) {
        // ignore non-json
      }
    };

    ws.on('message', handler);
  });
}

test('websocket: client connects and receives welcome message', async () => {
  const ws = await connectClient();
  const welcome = await waitForMessage(ws, msg => msg.type === 'connected');
  assert.equal(welcome.type, 'connected');
  ws.close();
});

test('websocket: client receives real-time book updates on order placement', async () => {
  const ws = await connectClient();
  await waitForMessage(ws, msg => msg.type === 'connected');

  // Subscribe to book
  ws.send(JSON.stringify({ action: 'subscribe', channel: 'book', symbol: 'AAPL' }));
  await waitForMessage(ws, msg => msg.type === 'subscribed');

  const bookUpdatePromise = waitForMessage(ws, msg => msg.type === 'book_update' && msg.symbol === 'AAPL');

  // Place order via service
  await orderService.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 25, price: 227.0 });

  const update = await bookUpdatePromise;
  assert.equal(update.type, 'book_update');
  assert.equal(update.symbol, 'AAPL');
  assert.deepEqual(update.bids, [[227.0, 25]]);

  ws.close();
});

test('websocket: client receives trade execution notification on match', async () => {
  const ws = await connectClient();
  await waitForMessage(ws, msg => msg.type === 'connected');

  ws.send(JSON.stringify({ type: 'subscribe', channels: ['trades'], symbols: ['AAPL'] }));
  await waitForMessage(ws, msg => msg.type === 'subscribed');

  // Place resting sell order
  await orderService.placeOrder({ symbol: 'AAPL', side: 'sell', qty: 10, price: 227.5 });

  const tradePromise = waitForMessage(ws, msg => msg.type === 'trade_execution' && msg.symbol === 'AAPL');

  // Place crossing buy order to trigger match
  await orderService.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 10, price: 227.5 });

  const trade = await tradePromise;
  assert.equal(trade.type, 'trade_execution');
  assert.equal(trade.symbol, 'AAPL');
  assert.equal(trade.price, 227.5);
  assert.equal(trade.qty, 10);
  assert.match(trade.trade_id, /^TRD-\d{6}$/);

  ws.close();
});

test('websocket: client receives circuit breaker notification on volatility trip', async () => {
  const ws = await connectClient();
  await waitForMessage(ws, msg => msg.type === 'connected');

  ws.send(JSON.stringify({ type: 'subscribe', channels: ['circuit_breaker'], symbols: ['AAPL'] }));
  await waitForMessage(ws, msg => msg.type === 'subscribed');

  const cbPromise = waitForMessage(ws, msg => msg.type === 'circuit_breaker' && msg.symbol === 'AAPL');

  circuitBreakerService.trip('AAPL', 'Simulated 15% price spike');

  const cbMsg = await cbPromise;
  assert.equal(cbMsg.type, 'circuit_breaker');
  assert.equal(cbMsg.symbol, 'AAPL');
  assert.equal(cbMsg.state, 'OPEN');

  ws.close();
});
