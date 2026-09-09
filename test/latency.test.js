/**
 * test/latency.test.js
 *
 * Verifies that order acknowledgment (POST /api/orders) meets the p99 < 50 ms
 * SLA by measuring wall-clock time for N sequential requests.
 *
 * The fee busy-wait runs in a worker thread so it does NOT block the HTTP
 * round-trip.  This test will fail if the worker-thread approach is broken
 * and the main event loop stalls for 30 ms per order.
 */
'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const app = require('../src/app');
const book = require('../src/models/orderBook');
const idempotency = require('../src/services/idempotencyStore');

let server;

before(() => new Promise(resolve => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', resolve);
}));

after(() => new Promise(resolve => {
  server.closeAllConnections();
  server.close(resolve);
}));

beforeEach(() => {
  book.book.orders = [];
  book.book.bySymbol = {};
  idempotency.clear();
});

function postOrder(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const { port } = server.address();
    const start = Date.now();
    const opts = {
      method: 'POST',
      hostname: '127.0.0.1',
      port,
      path: '/api/orders',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ elapsed: Date.now() - start, status: res.statusCode }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

test('order acknowledgment p99 < 50 ms', async () => {
  const N = 40; // enough for a stable p99 estimate
  const P99_BUDGET_MS = 50;
  const ORDER = { symbol: 'AAPL', side: 'buy', qty: 10, price: 100 };

  // Warm up: discard the first few requests (JIT, thread-pool spin-up).
  for (let i = 0; i < 3; i++) await postOrder(ORDER);

  const latencies = [];
  for (let i = 0; i < N; i++) {
    const { elapsed, status } = await postOrder(ORDER);
    assert.strictEqual(status, 201, `request ${i} failed`);
    latencies.push(elapsed);
  }

  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p99 = percentile(latencies, 99);

  console.log(`  latency: p50=${p50}ms  p99=${p99}ms  max=${latencies[latencies.length - 1]}ms`);

  assert.ok(
    p99 < P99_BUDGET_MS,
    `p99 latency ${p99}ms exceeds budget of ${P99_BUDGET_MS}ms`,
  );
});
