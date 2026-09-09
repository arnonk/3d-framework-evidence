const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const orderService = require('../src/services/orderService');
const { engine } = require('../src/models/orderBook');
const { circuitBreakerService } = require('../src/services/circuitBreakerService');
const { resetIdSequence } = require('../src/models/order');

beforeEach(() => {
  engine.clear();
  circuitBreakerService.clear();
  circuitBreakerService.setReferencePrice('AAPL', 227.5);
  resetIdSequence(1);
});

test('performance: order acknowledgment latency p99 is under 50ms and throughput > 1000 orders/sec', async () => {
  const ORDER_COUNT = 1000;
  const latencies = [];

  const startTime = performance.now();

  for (let i = 0; i < ORDER_COUNT; i++) {
    const t0 = performance.now();
    // Alternate buy and sell orders around 227.5 to simulate active matching
    const side = i % 2 === 0 ? 'buy' : 'sell';
    const price = side === 'buy' ? 227.0 : 228.0;

    await orderService.placeOrder({
      symbol: 'AAPL',
      side,
      qty: 10,
      price,
    });

    const elapsed = performance.now() - t0;
    latencies.push(elapsed);
  }

  const totalTimeMs = performance.now() - startTime;
  const throughputOrdersPerSec = (ORDER_COUNT / (totalTimeMs / 1000));

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(ORDER_COUNT * 0.50)];
  const p95 = latencies[Math.floor(ORDER_COUNT * 0.95)];
  const p99 = latencies[Math.floor(ORDER_COUNT * 0.99)];
  const max = latencies[latencies.length - 1];

  console.log(`[PERFORMANCE BENCHMARK] ${ORDER_COUNT} orders:`);
  console.log(`  Total time: ${totalTimeMs.toFixed(2)}ms`);
  console.log(`  Throughput: ${throughputOrdersPerSec.toFixed(0)} orders/sec`);
  console.log(`  p50: ${p50.toFixed(3)}ms`);
  console.log(`  p95: ${p95.toFixed(3)}ms`);
  console.log(`  p99: ${p99.toFixed(3)}ms`);
  console.log(`  max: ${max.toFixed(3)}ms`);

  // Assert non-functional requirements
  assert.ok(p99 < 50.0, `Expected p99 latency < 50ms, got ${p99.toFixed(2)}ms`);
  assert.ok(throughputOrdersPerSec > 1000, `Expected throughput > 1000 orders/sec, got ${throughputOrdersPerSec.toFixed(0)}`);
});
