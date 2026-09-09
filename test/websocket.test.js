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

class TestWsClient {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.listeners = [];

    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        this.messages.push(msg);
        for (const item of [...this.listeners]) {
          if (item.predicate(msg)) {
            clearTimeout(item.timer);
            this.listeners = this.listeners.filter(l => l !== item);
            item.resolve(msg);
          }
        }
      } catch (err) {
        // ignore non-json
      }
    });
  }

  send(payload) {
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  close() {
    this.ws.close();
  }

  waitFor(predicate, timeoutMs = 2000) {
    const idx = this.messages.findIndex(predicate);
    if (idx !== -1) {
      const [msg] = this.messages.splice(idx, 1);
      return Promise.resolve(msg);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter(l => l.resolve !== resolve);
        reject(new Error('Timed out waiting for WebSocket message'));
      }, timeoutMs);
      this.listeners.push({ predicate, resolve, timer });
    });
  }
}

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
    const rawWs = new WebSocket(`ws://localhost:${port}/ws`);
    const client = new TestWsClient(rawWs);
    rawWs.on('open', () => resolve(client));
    rawWs.on('error', reject);
  });
}

test('websocket: client connects and receives welcome message', async () => {
  const client = await connectClient();
  const welcome = await client.waitFor(msg => msg.type === 'connected');
  assert.equal(welcome.type, 'connected');
  client.close();
});

test('websocket: client receives real-time book updates on order placement', async () => {
  const client = await connectClient();
  await client.waitFor(msg => msg.type === 'connected');

  // Subscribe to book
  client.send({ action: 'subscribe', channel: 'book', symbol: 'AAPL' });
  await client.waitFor(msg => msg.type === 'subscribed');

  // Place order via service
  await orderService.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 25, price: 227.0 });

  const update = await client.waitFor(msg => msg.type === 'book_update' && msg.symbol === 'AAPL');
  assert.equal(update.type, 'book_update');
  assert.equal(update.symbol, 'AAPL');
  assert.deepEqual(update.bids, [[227.0, 25]]);

  client.close();
});

test('websocket: client receives trade execution notification on match', async () => {
  const client = await connectClient();
  await client.waitFor(msg => msg.type === 'connected');

  client.send({ type: 'subscribe', channels: ['trades'], symbols: ['AAPL'] });
  await client.waitFor(msg => msg.type === 'subscribed');

  // Place resting sell order
  await orderService.placeOrder({ symbol: 'AAPL', side: 'sell', qty: 10, price: 227.5 });

  // Place crossing buy order to trigger match
  await orderService.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 10, price: 227.5 });

  const trade = await client.waitFor(msg => msg.type === 'trade_execution' && msg.symbol === 'AAPL');
  assert.equal(trade.type, 'trade_execution');
  assert.equal(trade.symbol, 'AAPL');
  assert.equal(trade.price, 227.5);
  assert.equal(trade.qty, 10);
  assert.match(trade.trade_id, /^TRD-\d{6}$/);

  client.close();
});

test('websocket: client receives circuit breaker notification on volatility trip', async () => {
  const client = await connectClient();
  await client.waitFor(msg => msg.type === 'connected');

  client.send({ type: 'subscribe', channels: ['circuit_breaker'], symbols: ['AAPL'] });
  await client.waitFor(msg => msg.type === 'subscribed');

  circuitBreakerService.trip('AAPL', 'Simulated 15% price spike');

  const cbMsg = await client.waitFor(msg => msg.type === 'circuit_breaker' && msg.symbol === 'AAPL');
  assert.equal(cbMsg.type, 'circuit_breaker');
  assert.equal(cbMsg.symbol, 'AAPL');
  assert.equal(cbMsg.state, 'OPEN');

  client.close();
});
