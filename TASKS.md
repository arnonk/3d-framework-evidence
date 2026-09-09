# TASKS — Real-Time Trade Execution Engine
**Repository:** `order-service` v1.2.0  
**Spec:** [SPEC.md](./SPEC.md)  
_Tasks are ordered by dependency. Each task is independently verifiable before the next begins._

---

## T-01 · Extend `config.js` with new runtime knobs

**Motivation:** Every subsequent task reads circuit-breaker and logging config. This must land first so all modules share a single source of truth.

**Files modified:**
- `src/config.js`

**Changes:**
- Add `bandPct` (env `BAND_PCT`, default `5`)
- Add `bandWindowMs` (env `BAND_WINDOW_MS`, default `60000`)
- Add `breakerResetMs` (env `BREAKER_RESET_MS`, default `30000`)
- Add `logLevel` (env `LOG_LEVEL`, default `"info"`)
- Make `maxOrderQty` read `MAX_ORDER_QTY` env (keep exported key the same).
- Make `defaultFeeBps` read `DEFAULT_FEE_BPS` env (keep exported key the same).

**Verification:**
```
node -e "
  const c = require('./src/config');
  console.assert(c.bandPct === 5);
  console.assert(c.bandWindowMs === 60000);
  console.assert(c.breakerResetMs === 30000);
  console.assert(c.logLevel === 'info');
  console.log('T-01 PASS');
"
```

---

## T-02 · Replace `logger.js` with structured JSON logger

**Motivation:** NFR-7 requires newline-delimited JSON to stdout with `ts`, `level`, `event`, and optional `order_id`/`symbol`/`latency_ms`. The current `logger.js` writes plain text.

**Files modified:**
- `src/utils/logger.js`

**Changes:**
- Replace `info/warn/error` implementations to `JSON.stringify` a log record and write to `process.stdout`.
- Record shape: `{ ts: <ISO-8601>, level: "info"|"warn"|"error"|"debug", event, order_id?, symbol?, latency_ms?, ...rest }`.
- Respect `config.logLevel`: suppress messages below the configured level.
- Keep same exported API (`{ info, warn, error }`); add `debug`.

**Verification:**
```
node -e "
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { out.push(s); orig(s); };
  const log = require('./src/utils/logger');
  log.info({ event: 'test', order_id: 'ORD-000001', latency_ms: 3 });
  const rec = JSON.parse(out[0]);
  console.assert(rec.level === 'info');
  console.assert(typeof rec.ts === 'string');
  console.assert(rec.event === 'test');
  console.assert(rec.latency_ms === 3);
  console.log('T-02 PASS');
"
```

---

## T-03 · Remove `legacyLedgerSync`; make fee computation async

**Motivation:** FR-1.4 / NFR-1. The 30 ms spin-loop blocks the event loop and makes the p99 < 50 ms target impossible.

**Files modified:**
- `src/services/orderService.js`

**Changes:**
- Delete `legacyLedgerSync` entirely.
- Convert `computeFee(qty, price)` to return a `Promise` (wrap computation in `setImmediate` or `Promise.resolve().then(…)`).
- Update `placeOrder` and `quote` to `await computeFee(…)`.
- Keep the fee formula `Math.floor(qty * price * bps / 10000 + 0.4999)` byte-for-byte identical.
- Wrap the async implementation in a backward-compat callback shim so existing callers are unaffected.

**Verification:**
```
node -e "
  const svc = require('./src/services/orderService');
  const start = Date.now();
  svc.placeOrder({ symbol:'AAPL', side:'buy', qty:100, price:227.5 }, (e, o) => {
    const elapsed = Date.now() - start;
    console.assert(!e, e);
    console.assert(o.fee === 27, 'fee mismatch: ' + o.fee);
    console.assert(elapsed < 20, 'still too slow: ' + elapsed + 'ms');
    console.log('T-03 PASS (elapsed=' + elapsed + 'ms)');
  });
"
```

---

## T-04 · Add idempotency store

**Motivation:** FR-1.2 / NFR-3. Deduplication of orders by `idempotency_key`.

**Files created:**
- `src/services/idempotencyStore.js`

**Changes:**
- Export `{ get(key), set(key, response), sweep(), _forceExpire(key) }`.
- Internal Map stores `{ response, expiresAt }` where `expiresAt = Date.now() + 24 * 3600 * 1000`.
- `sweep()` deletes entries where `Date.now() > expiresAt`.
- Module schedules `setInterval(sweep, 5 * 60 * 1000)` on load.
- `_forceExpire(key)` is a test-only helper that sets `expiresAt` to 0.

**Files modified:**
- `src/services/orderService.js`
  - In `placeOrder`: if `body.idempotency_key` is set and `idempotencyStore.get(key)` is non-null, immediately return the cached response via `cb`.
  - After successful placement: call `idempotencyStore.set(key, order)` when key is present.

**Verification:**
```
node -e "
  const store = require('./src/services/idempotencyStore');
  store.set('k1', { order_id: 'ORD-000001', status: 'accepted', fee: 27 });
  console.assert(store.get('k1').order_id === 'ORD-000001');
  store._forceExpire('k1');
  store.sweep();
  console.assert(store.get('k1') === undefined);
  const svc = require('./src/services/orderService');
  const body = { symbol:'AAPL', side:'buy', qty:10, price:200, idempotency_key:'idem-test-1' };
  svc.placeOrder(body, (e, o1) => {
    svc.placeOrder(body, (e2, o2) => {
      console.assert(o1.id === o2.id, 'ids differ');
      console.log('T-04 PASS');
    });
  });
"
```

---

## T-05 · Implement circuit-breaker service

**Motivation:** FR-6 / NFR-4.

**Files created:**
- `src/services/circuitBreaker.js`

**Changes:**
- Extends `EventEmitter`. Exports `{ evaluate(symbol, price), isOpen(symbol), reset(symbol), all(), on, off }`.
- `evaluate`: if `|price - referencePrice| / referencePrice * 100 > BAND_PCT`, trips the breaker and schedules auto-reset after `BREAKER_RESET_MS`. Emits `'trip'` event.
- `reset`: closes the breaker manually, emits `'reset'` event.
- Reference price is the first price seen per symbol in each closed window; resets when breaker closes.
- All config read from `src/config.js`.

**Files modified:**
- `src/services/pricingService.js`
  - Add `setPrice(symbol, price)`: updates `PRICES[symbol]` and calls `circuitBreaker.evaluate(symbol, price)`.

**Verification:**
```
node -e "
  const cb = require('./src/services/circuitBreaker');
  const pricing = require('./src/services/pricingService');
  pricing.setPrice('AAPL', 200);
  console.assert(!cb.isOpen('AAPL'), 'should be closed');
  pricing.setPrice('AAPL', 211);
  console.assert(cb.isOpen('AAPL'), 'should be open after 5.5% move');
  cb.reset('AAPL');
  console.assert(!cb.isOpen('AAPL'), 'should be closed after reset');
  console.log('T-05 PASS');
"
```

---

## T-06 · Enforce circuit breaker on order-placement hot path

**Motivation:** NFR-4 — breaker check must happen before any write.

**Files modified:**
- `src/services/orderService.js`
  - At start of `placeOrder`, after idempotency check, call `circuitBreaker.isOpen(body.symbol)`.
  - If open, invoke `cb` with typed error `{ type: 'CIRCUIT_BREAKER_OPEN', symbol, reference_price, band_pct }`.
- `src/routes/orders.js`
  - Detect `err.type === 'CIRCUIT_BREAKER_OPEN'` and return HTTP 422 with `{ error: "circuit breaker open", symbol, reference_price, band_pct }`.

**Files created:**
- `src/routes/circuitBreakers.js`
  - `GET /api/circuit-breakers` — returns `circuitBreaker.all()`.
  - `DELETE /api/circuit-breakers/:symbol` — calls `circuitBreaker.reset(symbol)`; 404 if unknown.

**Files modified:**
- `src/app.js`
  - Mount `require('./routes/circuitBreakers')` under `/api`.

**Verification:**
```
node -e "
  const app = require('./src/app');
  const http = require('http');
  const pricing = require('./src/services/pricingService');
  pricing.setPrice('AAPL', 200);
  pricing.setPrice('AAPL', 220);
  const server = http.createServer(app).listen(0, () => {
    const port = server.address().port;
    const body = JSON.stringify({ symbol:'AAPL', side:'buy', qty:1, price:220 });
    const req = http.request({ port, method:'POST', path:'/api/orders',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          console.assert(res.statusCode === 422, 'expected 422 got ' + res.statusCode);
          console.assert(JSON.parse(d).error === 'circuit breaker open');
          server.close(() => console.log('T-06 PASS'));
        });
      });
    req.write(body); req.end();
  });
"
```

---

## T-07 · Add `POST /api/prices` internal endpoint

**Motivation:** FR-7.2 — test harnesses and future market-data adapters push price updates over HTTP.

**Files created:**
- `src/routes/prices.js`
  - `POST /api/prices`: validates `{ symbol: string, price: number > 0 }`, calls `pricingService.setPrice(symbol, price)`, returns `200 { ok: true }`.

**Files modified:**
- `src/app.js`
  - Mount `require('./routes/prices')` under `/api`.

**Verification:**
```
node -e "
  const app = require('./src/app');
  const http = require('http');
  const pricing = require('./src/services/pricingService');
  const server = http.createServer(app).listen(0, () => {
    const port = server.address().port;
    const body = JSON.stringify({ symbol:'GOOGL', price: 175.5 });
    const req = http.request({ port, method:'POST', path:'/api/prices',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} },
      res => {
        console.assert(res.statusCode === 200);
        console.assert(pricing.lastPrice('GOOGL') === 175.5);
        server.close(() => console.log('T-07 PASS'));
      });
    req.write(body); req.end();
  });
"
```

---

## T-08 · Implement WebSocket server with subscription management

**Motivation:** FR-5 / §3.3 of SPEC.

**Files created:**
- `src/ws/wsServer.js`
  - Attaches a `ws` WebSocket server to an `http.Server` at path `/ws`.
  - Maintains `Map<WebSocket, { symbols: Set<string> }>`.
  - On connect: sends `book_snapshot` for `*`.
  - Handles: `subscribe`, `unsubscribe`, `ping`; sends `error` for unknown types.
  - Exports `{ attach(server), broadcast(symbol, message), connectionCount(), closeAll(code, reason) }`.

**Files modified:**
- `src/index.js`
  - Use `http.createServer(app)` explicitly.
  - Call `wsServer.attach(server)` after `server.listen(…)`.
  - On `SIGTERM`: call `wsServer.closeAll(1001, 'server going away')` then `server.close(…)`.

**Files modified:**
- `package.json`
  - Add `"ws": "^8.18.0"` to `dependencies`.

**Verification:**
```
node -e "
  const http = require('http');
  const app = require('./src/app');
  const wsServer = require('./src/ws/wsServer');
  const WebSocket = require('ws');
  const server = http.createServer(app);
  wsServer.attach(server);
  server.listen(0, () => {
    const port = server.address().port;
    const ws = new WebSocket('ws://localhost:' + port + '/ws');
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.type === 'book_snapshot') {
        console.assert(Array.isArray(msg.bids));
        console.assert(Array.isArray(msg.asks));
        ws.close();
        server.close(() => console.log('T-08 PASS'));
      }
    });
  });
"
```

---

## T-09 · Broadcast `trade_execution` and `book_update` on order placement

**Motivation:** FR-1.3 / FR-5.2.

**Files modified:**
- `src/services/orderService.js`
  - After `book.add(order)`, call `wsServer.broadcast` with `trade_execution` and `book_update` payloads.
  - Import `wsServer` lazily (inside function) to avoid circular-dependency issues.

**Verification:**
```
node -e "
  const http = require('http');
  const app = require('./src/app');
  const wsServer = require('./src/ws/wsServer');
  const WebSocket = require('ws');
  const server = http.createServer(app);
  wsServer.attach(server);
  server.listen(0, () => {
    const port = server.address().port;
    const ws = new WebSocket('ws://localhost:' + port + '/ws');
    ws.on('open', () => {
      const body = JSON.stringify({ symbol:'MSFT', side:'buy', qty:10, price:415 });
      const req = http.request({ port, method:'POST', path:'/api/orders',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} }, () => {});
      req.write(body); req.end();
    });
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type === 'trade_execution') {
        console.assert(m.order_id.startsWith('ORD-'));
        ws.close();
        server.close(() => console.log('T-09 PASS'));
      }
    });
  });
"
```

---

## T-10 · Broadcast `circuit_breaker` events over WebSocket

**Motivation:** FR-6.6 / FR-5.3.

**Files modified:**
- `src/ws/wsServer.js`
  - On `attach`: subscribe to `circuitBreaker.on('trip', …)` and `circuitBreaker.on('reset', …)`; broadcast `circuit_breaker` event to affected symbol subscribers.
  - On new `subscribe` message for a symbol with an open breaker, immediately push a `circuit_breaker` event to that client.

**Files modified:**
- `src/services/circuitBreaker.js`
  - Ensure `EventEmitter` is wired; `trip` and `reset` events carry the full payload from §3.3.2 of SPEC.

**Verification:**
```
node -e "
  const http = require('http');
  const app = require('./src/app');
  const wsServer = require('./src/ws/wsServer');
  const pricing = require('./src/services/pricingService');
  const WebSocket = require('ws');
  const server = http.createServer(app);
  wsServer.attach(server);
  server.listen(0, () => {
    const port = server.address().port;
    pricing.setPrice('TSLA', 200);
    const ws = new WebSocket('ws://localhost:' + port + '/ws');
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', symbol: 'TSLA' }));
      setTimeout(() => pricing.setPrice('TSLA', 215), 50);
    });
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type === 'circuit_breaker' && m.state === 'open') {
        console.assert(m.symbol === 'TSLA');
        ws.close();
        server.close(() => console.log('T-10 PASS'));
      }
    });
  });
"
```

---

## T-11 · Extend `GET /api/health` with breaker and WS stats

**Motivation:** FR-4.1.

**Files modified:**
- `src/routes/health.js`
  - Import `circuitBreaker` and `wsServer`.
  - Extend response: `{ status:'up', ts: Date.now(), circuit_breakers: { [s]: 'open'|'closed' }, ws_connections: wsServer.connectionCount() }`.

**Verification:**
```
node -e "
  const app = require('./src/app');
  const http = require('http');
  const wsServer = require('./src/ws/wsServer');
  const server = http.createServer(app);
  wsServer.attach(server);
  server.listen(0, () => {
    http.get('http://localhost:' + server.address().port + '/api/health', res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const j = JSON.parse(d);
        console.assert(j.status === 'up');
        console.assert(typeof j.circuit_breakers === 'object');
        console.assert(typeof j.ws_connections === 'number');
        server.close(() => console.log('T-11 PASS'));
      });
    });
  });
"
```

---

## T-12 · Add `?symbol=` filter to `GET /api/orders`

**Motivation:** FR-2.3.

**Files modified:**
- `src/services/orderService.js`
  - `listOrders(options, cb)` — `options` is `{ symbol?: string }`. Filter `book.all()` when `symbol` is set.
  - Backward compat: if called as `listOrders(cb)`, treat options as `{}`.
- `src/routes/orders.js`
  - Pass `{ symbol: req.query.symbol }` to `listOrders`.

**Verification:**
```
node -e "
  const svc = require('./src/services/orderService');
  let placed = 0;
  const bodies = [
    { symbol:'AAPL', side:'buy', qty:1, price:200 },
    { symbol:'MSFT', side:'sell', qty:2, price:400 },
  ];
  bodies.forEach(b => svc.placeOrder(b, () => {
    if (++placed === 2) {
      svc.listOrders({ symbol:'AAPL' }, (e, orders) => {
        console.assert(orders.every(o => o.symbol === 'AAPL'));
        svc.listOrders((e2, all) => {
          console.assert(all.length >= 2);
          console.log('T-12 PASS');
        });
      });
    }
  }));
"
```

---

## T-13 · Structured logging with `latency_ms` on every order path

**Motivation:** NFR-7 / FR-4.2.

**Files modified:**
- `src/services/orderService.js`
  - Capture `const t0 = Date.now()` at the top of `placeOrder`.
  - After placement: `logger.info({ event: 'order_placed', order_id: order.id, symbol, latency_ms: Date.now() - t0 })`.
  - On circuit-breaker rejection: `logger.warn({ event: 'order_rejected_breaker', symbol, latency_ms: Date.now() - t0 })`.

**Verification:**
```
node -e "
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s, ...a) => { try { lines.push(JSON.parse(s)); } catch {} return orig(s, ...a); };
  const svc = require('./src/services/orderService');
  svc.placeOrder({ symbol:'NVDA', side:'buy', qty:5, price:131 }, (e, o) => {
    const rec = lines.find(l => l.event === 'order_placed' && l.order_id === o.id);
    console.assert(rec, 'log record not found');
    console.assert(typeof rec.latency_ms === 'number' && rec.latency_ms < 50);
    console.log('T-13 PASS');
  });
"
```

---

## T-14 · Latency regression test (p99 < 50 ms)

**Motivation:** NFR-1 / CI gate against `legacyLedgerSync` reintroduction.

**Files created:**
- `test/latency.test.js`

**Changes:**
- Uses `node:test` and `node:assert`.
- Spins up app on random port; fires 500 sequential `POST /api/orders`; records wall-clock latency per request.
- Asserts p99 < 50 ms.

**Verification:**
```
node --test test/latency.test.js
# Must exit 0.
```

---

## T-15 · Idempotency integration test

**Motivation:** NFR-3 / FR-1.2.

**Files created:**
- `test/idempotency.test.js`

**Changes:**
- Two identical requests with same `idempotency_key` → same `order_id`.
- Third request with different key → new `order_id`.
- `GET /api/orders` shows exactly two distinct orders.

**Verification:**
```
node --test test/idempotency.test.js
```

---

## T-16 · Circuit-breaker integration test

**Motivation:** FR-6 / NFR-4.

**Files created:**
- `test/circuitBreaker.test.js`

**Changes:**
- Push baseline price → push >5% price → assert `GET /api/circuit-breakers` shows `open`.
- Assert `POST /api/orders` returns 422.
- `DELETE /api/circuit-breakers/:symbol` → assert `closed` → assert orders accepted.

**Verification:**
```
node --test test/circuitBreaker.test.js
```

---

## T-17 · WebSocket integration test

**Motivation:** FR-5, FR-1.3, FR-5.3.

**Files created:**
- `test/websocket.test.js`

**Changes:**
- Connect → assert `book_snapshot` received.
- Place order → assert `trade_execution` with matching `order_id`.
- Trip breaker → assert `circuit_breaker` event with `state: "open"`.
- Unsubscribe from symbol → assert no further events for that symbol.

**Verification:**
```
node --test test/websocket.test.js
```

---

## T-18 · Backward-compatibility smoke test for all existing REST endpoints

**Motivation:** NFR-5 / Risk — partner "hermes" must not break.

**Files created:**
- `test/api.test.js`

**Changes:**
- `POST /api/orders` → response has exactly `{ order_id, status, fee }` at minimum; shape is validated.
- `GET /api/orders` → `{ orders: [ { id, symbol, side, qty, price, status } ] }`.
- `GET /api/orders/:id` → single order or 404.
- `POST /api/quote` → `{ symbol, price, fee }`.
- `GET /api/health` → `{ status, ts }` still present.

**Verification:**
```
node --test test/api.test.js
```

---

## T-19 · End-to-end test runner script

**Motivation:** Single `bash run-tests.sh` command for CI.

**Files created:**
- `run-tests.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "=== T-14 latency ==="        && node --test test/latency.test.js
echo "=== T-15 idempotency ==="    && node --test test/idempotency.test.js
echo "=== T-16 circuit-breaker ===" && node --test test/circuitBreaker.test.js
echo "=== T-17 websocket ==="      && node --test test/websocket.test.js
echo "=== T-18 api compat ==="     && node --test test/api.test.js
echo "ALL TESTS PASSED"
```

**Verification:**
```
bash run-tests.sh
# Exits 0 and prints "ALL TESTS PASSED".
```

---

## Dependency Graph

```
T-01 (config)
  └─► T-02 (logger)
        └─► T-03 (async fee)
              ├─► T-04 (idempotency store)
              ├─► T-05 (circuit breaker service)
              │     ├─► T-06 (enforce CB on order path)
              │     │     └─► T-07 (POST /api/prices)
              │     │           └─► T-08 (WS server)
              │     │                 ├─► T-09 (broadcast trade_execution)
              │     │                 └─► T-10 (broadcast circuit_breaker)
              │     │                       └─► T-11 (health endpoint)
              ├─► T-12 (symbol filter)
              └─► T-13 (structured logging)

T-14 depends on T-03, T-13
T-15 depends on T-04
T-16 depends on T-05, T-06, T-07
T-17 depends on T-08, T-09, T-10
T-18 depends on all T-0x tasks
T-19 depends on T-14 … T-18
```
