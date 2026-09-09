# TASKS.md - Implementation Plan & Task List

## Task List

### Task 1: Configuration & Event Bus Infrastructure
- **Files**: `src/config.js`, `src/utils/eventBus.js`
- **Actions**:
  - Add configuration keys for circuit breakers (price band %, volatility threshold %, sliding window ms, cooldown ms), idempotency cache TTL, and WebSocket settings.
  - Create centralized EventEmitter singleton in `src/utils/eventBus.js` with standard event definitions (`ORDER_PLACED`, `TRADES_EXECUTED`, `BOOK_UPDATED`, `CIRCUIT_BREAKER_TRIGGERED`, `CIRCUIT_BREAKER_RESET`, `PRICE_UPDATED`).
- **Verification**: Unit tests for event emitter publishing and subscribing.

### Task 2: Domain Model & Continuous Matching Engine
- **Files**: `src/models/order.js`, `src/models/orderBook.js`
- **Actions**:
  - Extend `Order` model with attributes for `filledQty`, `remainingQty`, `trades`, `clientOrderId`, timestamps, and sequence reset support.
  - Implement price-time priority matching engine within `src/models/orderBook.js` supporting limit orders, partial fills, full fills, maker price execution, and L2 depth aggregation (`bids`, `asks`, `bestBid`, `bestAsk`, `spread`).
  - Maintain backward compatibility of module exports: `book`, `add`, `find`, `all`.
- **Verification**: `test/matchingEngine.test.js` validating matching logic and order book depth.

### Task 3: Dynamic Price-Band & Volatility Circuit Breaker
- **Files**: `src/services/circuitBreakerService.js`
- **Actions**:
  - Implement dynamic reference price tracking per symbol.
  - Implement price-band validation: reject orders with price exceeding `[refPrice * (1 - bandPct), refPrice * (1 + bandPct)]`.
  - Implement sliding-window price history tracking and automatic transition to `OPEN` when volatility spike exceeds threshold.
  - Implement automatic cooldown recovery (`HALF_OPEN` -> `CLOSED`) and manual trip/reset controls.
- **Verification**: `test/circuitBreaker.test.js` validating price band checks, trip on spike, rejection when OPEN, and cooldown reset.

### Task 4: Idempotency Service
- **Files**: `src/services/idempotencyService.js`
- **Actions**:
  - Implement key extraction from HTTP headers and request body.
  - Implement cache for completed order results with TTL and parameter hashing.
  - Implement in-flight promise locks to safely serialize concurrent duplicate requests.
  - Detect and reject payload parameter mismatches for the same idempotency key with conflict error.
- **Verification**: `test/idempotency.test.js` validating duplicate replay, concurrency deduplication, and payload mismatch rejection.

### Task 5: High-Performance Order Service & Pricing Service
- **Files**: `src/services/orderService.js`, `src/services/pricingService.js`
- **Actions**:
  - In `src/services/orderService.js`, remove synchronous busy-wait `legacyLedgerSync` while keeping the exact `computeFee` mathematical formula and legacy rounding.
  - Integrate Matching Engine, Circuit Breaker checks, and Idempotency handling into `placeOrder`.
  - Keep backward-compatible callback signature `(err, order)` and response structure.
  - In `src/services/pricingService.js`, support dynamic price updates on trade execution and external feed updates while preserving static symbols and initial prices.
- **Verification**: `npm test` verifying fee formula invariance, execution speed (<1ms), and quote compatibility.

### Task 6: WebSocket Streaming Service
- **Files**: `src/services/wsService.js`, `src/app.js`, `src/index.js`
- **Actions**:
  - Implement WebSocket server using `ws` library attached to HTTP server.
  - Support topic/symbol subscriptions (`book`, `trades`, `circuit_breaker`) and ping/pong heartbeats.
  - Subscribe to EventBus and broadcast `book_update`, `trade_execution`, and `circuit_breaker` events to connected subscribers.
  - Update `src/index.js` to initialize the WebSocket server on the HTTP server instance.
- **Verification**: `test/websocket.test.js` validating WebSocket subscription, book updates, trade execution streaming, and circuit breaker notifications.

### Task 7: REST API Enhancement & Backward Compatibility
- **Files**: `src/routes/orders.js`, `src/routes/circuitBreakers.js` (or integrated in routes)
- **Actions**:
  - Update `src/routes/orders.js` to extract idempotency headers, handle circuit breaker rejections cleanly, and maintain the exact JSON response shape `{ order_id, status, fee }`.
  - Add operational endpoints `GET /api/book/:symbol` and `GET /api/circuit-breakers`.
  - Ensure deprecated `POST /api/quote` and `GET /api/orders` endpoints retain exact behavior.
- **Verification**: REST API integration tests.

### Task 8: Test Suite, Mocks, and Performance Benchmarking
- **Files**: `test/mocks/mockMarketFeed.js`, `test/matchingEngine.test.js`, `test/circuitBreaker.test.js`, `test/idempotency.test.js`, `test/websocket.test.js`, `test/performance.test.js`, `test/orders.test.js`
- **Actions**:
  - Implement deterministic `mockMarketFeed.js` capable of simulating normal random walks and configurable volatility spikes.
  - Implement comprehensive unit and integration test suite across all new and legacy capabilities.
  - Implement performance benchmark test verifying p99 acknowledgment latency < 50ms (target < 5ms) and throughput > 1000 orders/sec.
- **Verification**: Run `npm test` to ensure 100% test passing across the entire suite.
