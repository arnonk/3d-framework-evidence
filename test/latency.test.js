'use strict';

/**
 * Latency regression test – p99 of POST /api/orders must be < 50 ms (NFR-1).
 *
 * This test WILL FAIL against the current code because legacyLedgerSync(30)
 * adds at least 30 ms to every order, making p99 well above 50 ms.
 * It MUST PASS after T-03 removes the spin-loop.
 *
 * Method:
 *   - Fire N_ORDERS sequential POST /api/orders requests.
 *   - Measure wall-clock time per request (from write to response-end).
 *   - Assert that the p99 latency is < P99_TARGET_MS.
 *   - Also assert p50 < 10 ms (sanity check that the async path is fast).
 *
 * Sequential (not concurrent) requests are used deliberately: concurrent
 * requests would mask per-request event-loop blocking, which is exactly what
 * we need to detect.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, stopServer } = require('./helpers/testUtils');

const N_ORDERS = 500;       // spec says 500 sequential orders
const P99_TARGET_MS = 50;   // NFR-1
const P50_TARGET_MS = 10;   // sanity

let server;

before(async () => {
  const app = require('../src/app');
  server = await startServer(app);
});

after(async () => {
  await stopServer(server);
});

// ─── Percentile helper ────────────────────────────────────────────────────────

function percentile(sortedArr, p) {
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

// ─── Single-request helper (measures wall-clock from first-byte-write to last-chunk) ──

function timedRequest(port) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ symbol: 'AAPL', side: 'buy', qty: 1, price: 227.5 });
    const options = {
      hostname: '127.0.0.1',
      port,
      path: '/api/orders',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const t0 = Date.now(); // start just before write
    const req = http.request(options, (res) => {
      res.resume(); // drain
      res.on('end', () => resolve(Date.now() - t0));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('latency regression – legacyLedgerSync must be gone (NFR-1, T-03)', () => {
  test(`p99 of ${N_ORDERS} sequential POST /api/orders < ${P99_TARGET_MS} ms`, async () => {
    const port = server.address().port;
    const latencies = [];

    for (let i = 0; i < N_ORDERS; i++) {
      latencies.push(await timedRequest(port));
    }

    latencies.sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);
    const max = latencies[latencies.length - 1];

    // Emit stats for CI logs (not an assertion – purely informational)
    console.log(
      `[latency] n=${N_ORDERS} p50=${p50}ms p95=${p95}ms p99=${p99}ms max=${max}ms`
    );

    assert.ok(
      p99 < P99_TARGET_MS,
      `p99 latency ${p99} ms exceeds target of ${P99_TARGET_MS} ms. ` +
      `If legacyLedgerSync is still present, each request adds ≥30 ms on the event loop.`
    );
  });

  test(`p50 of ${N_ORDERS} sequential POST /api/orders < ${P50_TARGET_MS} ms (sanity)`, async () => {
    // Run a smaller batch for the p50 sanity check to keep total test time sane.
    const port = server.address().port;
    const latencies = [];
    for (let i = 0; i < 100; i++) {
      latencies.push(await timedRequest(port));
    }
    latencies.sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);

    assert.ok(
      p50 < P50_TARGET_MS,
      `p50 latency ${p50} ms exceeds sanity target of ${P50_TARGET_MS} ms`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('latency regression – GET /api/orders p99 < 5 ms (NFR-1)', () => {
  test('p99 of 200 sequential GET /api/orders < 5 ms', async () => {
    const port = server.address().port;
    const latencies = [];

    for (let i = 0; i < 200; i++) {
      const t0 = Date.now();
      await new Promise((resolve, reject) => {
        const req = http.get(
          { hostname: '127.0.0.1', port, path: '/api/orders' },
          (res) => { res.resume(); res.on('end', () => resolve(Date.now() - t0)); }
        );
        req.on('error', reject);
      });
      latencies.push(latencies[latencies.length - 1] ?? 0); // filled below
    }

    // Redo properly
    latencies.length = 0;
    for (let i = 0; i < 200; i++) {
      const t0 = Date.now();
      await new Promise((resolve, reject) => {
        http.get(
          { hostname: '127.0.0.1', port, path: '/api/orders' },
          (res) => { res.resume(); res.on('end', () => { latencies.push(Date.now() - t0); resolve(); }); }
        ).on('error', reject);
      });
    }

    latencies.sort((a, b) => a - b);
    const p99 = percentile(latencies, 99);
    console.log(`[latency-get] n=200 p99=${p99}ms`);
    assert.ok(p99 < 5, `GET /api/orders p99 ${p99} ms must be < 5 ms`);
  });
});
