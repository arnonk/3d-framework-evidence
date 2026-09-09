const { test, describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../src/app');
const book = require('../src/models/orderBook');

describe('Idempotent Order Placement Integration Tests', () => {
  let server;
  let baseUrl;

  before(async () => {
    await new Promise(resolve => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    // Reset book state if reset method exists or clear array
    if (book && Array.isArray(book.orders)) {
      book.orders.length = 0;
    }
    if (book && book.bySymbol) {
      for (const k of Object.keys(book.bySymbol)) delete book.bySymbol[k];
    }
  });

  it('places an order and returns 201 with order_id, status, and fee', async () => {
    const payload = { symbol: 'AAPL', side: 'buy', qty: 10, price: 227.5 };
    const res = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-test-key-1',
      },
      body: JSON.stringify(payload),
    });

    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.ok(data.order_id, 'order_id must be present in response');
    assert.strictEqual(data.status, 'accepted');
    assert.strictEqual(typeof data.fee, 'number');
  });

  it('replaying the identical request with the same idempotency key returns identical response without duplicating orders', async () => {
    const idempotencyKey = 'idem-duplicate-test-key-2';
    const payload = { symbol: 'AAPL', side: 'buy', qty: 50, price: 227.0 };

    // First request
    const res1 = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(res1.status, 201);
    const body1 = await res1.json();

    // Second request with same key and payload
    const res2 = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(res2.status, 201);
    const body2 = await res2.json();

    // Must return identical response
    assert.strictEqual(body2.order_id, body1.order_id);
    assert.strictEqual(body2.status, body1.status);
    assert.strictEqual(body2.fee, body1.fee);

    // Verify order book contains exactly one order
    const listRes = await fetch(`${baseUrl}/api/orders`);
    const listData = await listRes.json();
    assert.strictEqual(listData.orders.length, 1);
    assert.strictEqual(listData.orders[0].id, body1.order_id);
  });

  it('rejects duplicate idempotency key when payload differs (payload mismatch)', async () => {
    const idempotencyKey = 'idem-mismatch-key-3';
    const payload1 = { symbol: 'AAPL', side: 'buy', qty: 20, price: 227.0 };
    const payload2 = { symbol: 'AAPL', side: 'sell', qty: 20, price: 227.0 }; // different side

    const res1 = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload1),
    });
    assert.strictEqual(res1.status, 201);

    // Second request with altered payload
    const res2 = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload2),
    });

    // Should reject mismatch with 400 or 422
    assert.ok(res2.status === 400 || res2.status === 422, `Expected 400/422 on payload mismatch, got ${res2.status}`);
    const errorBody = await res2.json();
    assert.ok(errorBody.error);
  });

  it('handles concurrent identical requests with same idempotency key atomically', async () => {
    const idempotencyKey = 'idem-concurrent-key-4';
    const payload = { symbol: 'AAPL', side: 'buy', qty: 100, price: 226.5 };

    // Fire 5 concurrent requests simultaneously
    const requests = Array.from({ length: 5 }, () =>
      fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      })
    );

    const responses = await Promise.all(requests);
    const results = await Promise.all(responses.map(r => r.json()));

    // All should succeed with HTTP 201
    for (const res of responses) {
      assert.strictEqual(res.status, 201);
    }

    // All should return the exact same order_id
    const firstOrderId = results[0].order_id;
    for (const data of results) {
      assert.strictEqual(data.order_id, firstOrderId);
    }

    // Verify order book has only 1 order
    const listRes = await fetch(`${baseUrl}/api/orders`);
    const listData = await listRes.json();
    assert.strictEqual(listData.orders.length, 1);
  });
});
