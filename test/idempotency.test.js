const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { IdempotencyService } = require('../src/services/idempotencyService');

let idempotency;

beforeEach(() => {
  idempotency = new IdempotencyService({ ttlMs: 1000, maxKeys: 100 });
});

test('idempotency: key extraction from headers and body', () => {
  assert.equal(idempotency.extractKey({ headers: { 'idempotency-key': 'key-1' } }), 'key-1');
  assert.equal(idempotency.extractKey({ headers: { 'x-idempotency-key': 'key-2' } }), 'key-2');
  assert.equal(idempotency.extractKey({ body: { idempotency_key: 'key-3' } }), 'key-3');
  assert.equal(idempotency.extractKey({ body: { idempotencyKey: 'key-4' } }), 'key-4');
  assert.equal(idempotency.extractKey({ body: { client_order_id: 'key-5' } }), 'key-5');
  assert.equal(idempotency.extractKey({ body: { clientOrderId: 'key-6' } }), 'key-6');
  assert.equal(idempotency.extractKey({ headers: {}, body: {} }), null);
});

test('idempotency: retried request returns cached response without double executing', async () => {
  let executionCount = 0;
  const params = { symbol: 'AAPL', side: 'buy', qty: 10, price: 100 };

  const op = async () => {
    executionCount++;
    return { order_id: 'ORD-000001', status: 'accepted', fee: 12 };
  };

  const res1 = await idempotency.execute('client-req-123', params, op);
  assert.equal(res1.order_id, 'ORD-000001');
  assert.equal(executionCount, 1);

  // Second identical call
  const res2 = await idempotency.execute('client-req-123', params, op);
  assert.equal(res2.order_id, 'ORD-000001');
  assert.equal(res2.isDuplicate, true);
  assert.equal(executionCount, 1); // Not executed again!
});

test('idempotency: concurrent duplicate requests execute underlying operation exactly once', async () => {
  let executionCount = 0;
  const params = { symbol: 'MSFT', side: 'buy', qty: 50, price: 400 };

  const slowOp = async () => {
    executionCount++;
    await new Promise(resolve => setTimeout(resolve, 30));
    return { order_id: 'ORD-000002', status: 'accepted', fee: 240 };
  };

  // Launch 5 concurrent requests with the same idempotency key
  const results = await Promise.all([
    idempotency.execute('concurrent-key', params, slowOp),
    idempotency.execute('concurrent-key', params, slowOp),
    idempotency.execute('concurrent-key', params, slowOp),
    idempotency.execute('concurrent-key', params, slowOp),
    idempotency.execute('concurrent-key', params, slowOp),
  ]);

  assert.equal(executionCount, 1);
  for (const res of results) {
    assert.equal(res.order_id, 'ORD-000002');
  }
});

test('idempotency: key reused with different parameters throws conflict error', async () => {
  const op = async () => ({ order_id: 'ORD-000003' });
  const params1 = { symbol: 'AAPL', side: 'buy', qty: 10, price: 100 };
  const params2 = { symbol: 'AAPL', side: 'buy', qty: 20, price: 100 }; // Different qty

  await idempotency.execute('key-reuse', params1, op);

  await assert.rejects(
    async () => {
      await idempotency.execute('key-reuse', params2, op);
    },
    {
      code: 'IDEMPOTENCY_CONFLICT',
      statusCode: 409,
    }
  );
});
