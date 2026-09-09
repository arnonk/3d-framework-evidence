# TASKS.md: Real-Time Trade Execution Engine Implementation Plan

This document outlines the ordered, independently verifiable implementation tasks for building the real-time trade execution engine.

---

### Task 1: Continuous Limit Order Book (CLOB) & Matching Engine Core
- **Objective**: Implement the in-memory order book and continuous matching engine supporting price-time priority (FIFO), resting limit orders, trade execution generation, and partial/full fills.
- **Files Created / Modified**:
  - `src/models/order.js` (modify: support extended fields `filledQty`, `remainingQty`, `idempotencyKey`, and status transitions)
  - `src/models/orderBook.js` (modify: maintain sorted bid/ask levels, fast order lookup, L2 depth snapshots)
  - `src/models/matchingEngine.js` (create: CLOB matching engine logic, execution generation, emitter for book diffs and trades)
- **Requirements**:
  - Maintain bids descending by price, asks ascending by price; FIFO queue per price level.
  - Generate trade execution records with `tradeId`, `symbol`, `price`, `qty`, `buyOrderId`, `sellOrderId`, `makerOrderId`, `takerOrderId`, `timestamp`.
  - Update resting order remaining quantities and transition statuses (`open`, `partially_filled`, `filled`).
  - Provide a reset/clear function for test isolation.
- **Independent Verification**:
  - Run matching engine unit tests:
    ```bash
    node --test test/orders.test.js
    ```
  - Verify bids/asks match at maker price, partial fills leave remainder in book, and non-crossing orders rest in book.

---

### Task 2: Pricing Service & Volatility Price-Band Circuit Breaker
- **Objective**: Implement reference pricing updates and dynamic price-band circuit breaker logic to safeguard against market volatility spikes and fat-finger orders.
- **Files Created / Modified**:
  - `src/config.js` (modify: add `circuitBreakerBandPct: 5.0`, `maxVolatilityRatePct: 10.0`, `volatilityCooldownMs: 5000`)
  - `src/services/pricingService.js` (modify: support dynamic mark price updates upon trades, tick listeners, reference price retrieval)
  - `src/services/circuitBreaker.js` (create: price-band bounds calculation `[ref * (1 - bandPct), ref * (1 + bandPct)]`, order price validation against band, volatility spike detector)
- **Requirements**:
  - Calculate upper and lower price bands for any symbol given its reference price.
  - Validate incoming orders: reject buy orders with price > upper band; reject sell orders with price < lower band.
  - Update reference price dynamically when new trades occur or market ticks arrive.
  - Support symbol trading halt / cooldown when volatility exceeds threshold.
- **Independent Verification**:
  - Run circuit breaker unit tests:
    ```bash
    node --test test/orders.test.js
    ```
  - Verify in-band orders pass, out-of-band orders throw/return circuit breaker errors, and dynamic reference price shifts recalculate bands.

---

### Task 3: Optimized Fee Calculation & Idempotent Order Processing Service
- **Objective**: Eliminate event-loop-blocking busy-waits from fee computation and implement an atomic in-memory idempotency cache for order placement.
- **Files Created / Modified**:
  - `src/utils/validate.js` (modify: enhance validation for optional idempotencyKey, price bands, and symbol checks)
  - `src/services/idempotencyService.js` (create: in-memory key-value cache storing `{ status, body, timestamp, hash }`, mutex/promise locking for concurrent requests)
  - `src/services/orderService.js` (modify: remove `legacyLedgerSync(30)` CPU spin while preserving exact fee rounding formula, integrate matching engine, idempotency cache, and circuit breaker)
- **Requirements**:
  - Preserve exact historical fee rounding formula: `Math.floor(qty * price * bps / 10000 + 0.4999)`.
  - Fee calculation must be synchronous $O(1)$ without blocking the event loop.
  - Check idempotency key: return cached response if key matches previous request; prevent duplicate trade execution.
  - Return legacy callback signature `(err, order)` for backward compatibility.
- **Independent Verification**:
  - Run fee calculation and idempotency tests:
    ```bash
    node --test test/orders.test.js
    ```
  - Verify order placement latency is $< 1\text{ms}$ and duplicate idempotent submissions return identical `order_id` without creating duplicate orders.

---

### Task 4: Real-Time WebSocket Streaming Service
- **Objective**: Implement a high-performance WebSocket server supporting subscriptions to L2 order book snapshots/deltas, real-time trade executions, and order lifecycle updates.
- **Files Created / Modified**:
  - `package.json` (modify: add `ws` dependency if needed or configure WebSocket transport)
  - `src/services/websocketService.js` (create: WebSocket connection manager, subscription routing for `orderbook`, `trades`, and `orders`, broadcast dispatcher)
  - `src/app.js` (modify: export app or attach HTTP/WS handlers)
  - `src/index.js` (modify: attach WebSocket server to HTTP server instance, graceful shutdown handling)
- **Requirements**:
  - Handle client actions: `subscribe`, `unsubscribe`, `ping`.
  - On `orderbook` subscribe: immediately send full L2 `snapshot` (`bids` and `asks`).
  - On matching engine events: broadcast `book_update` (delta updates) and `trade` events to subscribed clients.
  - Microtask / non-blocking broadcast dispatch to maintain high throughput.
- **Independent Verification**:
  - Run WebSocket integration tests:
    ```bash
    node --test test/orders.test.js
    ```
  - Verify clients receive subscription confirmations, snapshots, real-time book updates, and trade execution events upon order matching.

---

### Task 5: REST API Integration & Backward Compatibility Verification
- **Objective**: Wire all engine components into the REST API routes, guaranteeing exact backward compatibility with existing partners while enabling circuit breakers and idempotency.
- **Files Created / Modified**:
  - `src/routes/orders.js` (modify: extract `Idempotency-Key` header, handle circuit breaker error status codes `422`, preserve legacy response shape `{ order_id, status, fee }`)
  - `src/routes/health.js` (modify: report health status, active WebSocket connections, and engine metrics)
- **Requirements**:
  - `POST /api/orders` returns HTTP 201 `{ order_id: string, status: string, fee: number }`.
  - `GET /api/orders` returns HTTP 200 `{ orders: [...] }`.
  - `GET /api/orders/:id` returns HTTP 200 full order details or 404.
  - `POST /api/quote` returns HTTP 200 `{ symbol, price, fee }`.
  - `GET /api/health` returns HTTP 200 `{ status: "up", ts: number }`.
  - Out-of-band circuit breaker rejections return HTTP 422 with informative error message.
- **Independent Verification**:
  - Run full test suite:
    ```bash
    npm test
    ```
  - Verify 100% test pass rate with zero regressions against legacy behavior.
