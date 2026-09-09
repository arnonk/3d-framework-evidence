const { test, before, after } = require('node:test');
const assert = require('node:assert');
const app = require('../src/app');
const http = require('http');

let server;
let baseUrl;

before(async () => {
  server = http.createServer(app);
  try {
    const wsService = require('../src/services/wsService');
    if (wsService.attach) wsService.attach(server);
  } catch (e) {}
  
  await new Promise((resolve) => {
    server.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
});

test('Integration: Idempotent order placement', async () => {
  const orderPayload = {
    symbol: 'AAPL',
    side: 'buy',
    qty: 10,
    price: 150
  };
  const idempotencyKey = 'req-test-12345';

  // First request
  const res1 = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(orderPayload)
  });
  
  assert.equal(res1.status, 201);
  const data1 = await res1.json();
  assert.ok(data1.order_id);

  // Second request with same idempotency key
  const res2 = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(orderPayload)
  });

  assert.equal(res2.status, 201);
  const data2 = await res2.json();
  
  // Must return the EXACT same order_id
  assert.equal(data1.order_id, data2.order_id, 'Idempotency key should return the exact same order instance');
});

test('Integration: WebSocket trade notifications stream', async () => {
  const wsUrl = baseUrl.replace('http', 'ws') + '/ws';
  
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      // In older node versions without native WebSocket, this throws.
      // We expect it to be available in Node 21+.
      return reject(new Error('WebSocket global not found'));
    }
    
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'subscribe',
        channels: ['trade'],
        symbol: 'TSLA'
      }));
      
      // Trigger a trade by placing crossing orders
      fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'TSLA', side: 'buy', qty: 50, price: 150.5 })
      });
      fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'TSLA', side: 'sell', qty: 50, price: 150.5 })
      });
    };
    
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'trade' && msg.symbol === 'TSLA') {
          assert.equal(msg.price, 150.5);
          assert.equal(msg.qty, 50);
          ws.close();
          resolve();
        }
      } catch (err) {
        ws.close();
        reject(err);
      }
    };
    
    ws.onerror = (err) => {
      reject(new Error('WebSocket connection failed - endpoint likely missing or server error'));
    };
    
    // Timeout if no message received within 2 seconds
    setTimeout(() => {
      if (ws.readyState !== ws.CLOSED) {
        ws.close();
        reject(new Error('Timeout waiting for WebSocket trade notification'));
      }
    }, 2000);
  });
});
