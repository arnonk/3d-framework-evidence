# SPEC.md - Real-Time Trade Execution Engine Specification

## 1. Executive Summary
This specification defines the extension of the legacy internal order routing service into a high-performance, real-time trade execution engine optimized for volatile markets. The engine supports sub-millisecond order acknowledgment (p99 < 50ms), idempotent order placement, dynamic price-band circuit breakers to prevent execution during market dislocations, and real-time streaming of L2 order book updates and trade execution reports over WebSocket.

---

## 2. Functional Requirements

### 2.1 Order Model & Continuous Matching Engine
- **Order Model**:
  - `id`: Unique identifier formatted as `ORD-XXXXXX` (sequential integer padded to 6 digits).
  - `symbol`: Trading instrument symbol (e.g., `AAPL`, `MSFT`, `TSLA`, `NVDA`).
  - `side`: `'buy'` or `'sell'`.
  - `qty`: Positive finite number (maximum bounded by `config.maxOrderQty`).
  - `price`: Positive finite limit price.
  - `status`: `'accepted'` | `'open'` | `'partially_filled'` | `'filled'` | `'rejected'` | `'cancelled'`.
  - `fee`: Calculated fee in integer units using legacy rounding rules.
  - `filledQty`: Cumulative executed quantity.
  - `remainingQty`: Remaining open quantity.
  - `trades`: Array of executed trade records associated with the order.
  - `clientOrderId` / `idempotencyKey`: Optional client-provided unique idempotency key.
  - `createdAt`: ISO 8601 timestamp.
  - `updatedAt`: ISO 8601 timestamp.

- **Continuous Price-Time Matching Engine**:
  - Continuous limit order matching using FIFO price-time priority.
  - Buy orders match against the lowest existing sell orders (asks) where `ask.price <= buy.price`.
  - Sell orders match against the highest existing buy orders (bids) where `bid.price >= sell.price`.
  - Trades are executed at the maker price (the resting order's price).
  - Unmatched or remaining quantities rest on the order book.
  - Trade execution generates trade records: `{ tradeId: 'TRD-XXXXXX', symbol, price, qty, buyOrderId, sellOrderId, timestamp }`.

### 2.2 Volatility Protection & Dynamic Price-Band Circuit Breakers
- **Dynamic Price Bands**:
  - Every symbol maintains a dynamic reference price $P_{\text{ref}}$, initialized from the pricing service and updated by executed trades / market feed.
  - Configurable price band percentage (default: $\pm 5\%$).
  - Allowable price range: $[P_{\text{ref}} \times (1 - \text{bandPct}), P_{\text{ref}} \times (1 + \text{bandPct})]$.
  - Orders submitted with a limit price outside the band are rejected with an explicit price-band violation error.
- **Volatility Spike Detection**:
  - Monitors price movements across a rolling time window (default: 5000ms).
  - If cumulative price change within the window exceeds the volatility threshold (default: $10\%$), the circuit breaker trips into the `OPEN` state.
- **Circuit Breaker States**:
  - `CLOSED`: Normal trading operations.
  - `OPEN`: Trading is halted for the symbol. All incoming orders for the symbol are immediately rejected.
  - `HALF_OPEN`: Cooldown recovery state after a configurable cooldown period (default: 3000ms), gradually resuming order processing.
- **Operational Controls**:
  - Programmatic and REST endpoints to inspect circuit breaker status, trip manually, or reset state.

### 2.3 Idempotency Guarantees
- **Identification**:
  - Keys extracted from HTTP headers (`Idempotency-Key`, `X-Idempotency-Key`) or request body (`idempotency_key`, `idempotencyKey`, `client_order_id`, `clientOrderId`).
- **Semantics**:
  - **Identical Retry**: When an identical order request is received with an already-processed idempotency key, the engine returns the cached response with status `201` and the original `order_id`, `status`, and `fee` without re-executing or altering the order book.
  - **In-Flight Deduplication**: Concurrent duplicate requests with the same key wait on an in-flight promise lock, ensuring single execution.
  - **Payload Mismatch Detection**: Reusing an idempotency key with different order parameters (different symbol, side, qty, or price) rejects with a `409 Conflict` (or `400 Bad Request`) error.

### 2.4 Real-Time WebSocket Streaming
- **Connection & Protocol**:
  - WebSocket endpoint attached to the HTTP server at `/ws` (and root).
  - JSON message format with subscribe/unsubscribe and ping/pong commands.
- **Channels**:
  - `book`: L2 order book depth updates (bids and asks arrays `[[price, qty], ...]`, best bid/ask, spread, last price).
  - `trades`: Real-time trade execution notifications (`trade_id`, `symbol`, `price`, `qty`, `buy_order_id`, `sell_order_id`, `timestamp`).
  - `circuit_breaker`: Circuit breaker state transition events (`symbol`, `state`, `reason`, `timestamp`).

---

## 3. API Contract

### 3.1 REST Endpoints (Backward Compatible)
- `POST /api/orders`
  - **Request Body**: `{ "symbol": "AAPL", "side": "buy", "qty": 100, "price": 227.5, "idempotency_key": "optional-key" }`
  - **Headers**: Optional `Idempotency-Key: <key>`
  - **Success Response**: Status `201 Created`
    ```json
    {
      "order_id": "ORD-000001",
      "status": "accepted",
      "fee": 273
    }
    ```
  - **Error Response**: Status `400 Bad Request` or `422 Unprocessable Entity`
    ```json
    {
      "error": "<error message>"
    }
    ```

- `GET /api/orders`
  - **Success Response**: Status `200 OK`
    ```json
    {
      "orders": [
        {
          "id": "ORD-000001",
          "symbol": "AAPL",
          "side": "buy",
          "qty": 100,
          "price": 227.5,
          "status": "accepted"
        }
      ]
    }
    ```

- `GET /api/orders/:id`
  - **Success Response**: Status `200 OK` with full order object.
  - **Error Response**: Status `404 Not Found` `{ "error": "order not found" }`.

- `POST /api/quote` (Deprecated partner endpoint)
  - **Request Body**: `{ "symbol": "AAPL", "qty": 10 }`
  - **Success Response**: Status `200 OK`
    ```json
    {
      "symbol": "AAPL",
      "price": 227.5,
      "fee": 27
    }
    ```
  - **Error Response**: Status `500 Internal Server Error` `{ "error": "unknown symbol" }`.

- `GET /api/health`
  - **Success Response**: Status `200 OK`
    ```json
    {
      "status": "up",
      "ts": 1725870000000
    }
    ```

- `GET /api/book/:symbol` (Operational Depth Endpoint)
  - **Success Response**: Status `200 OK`
    ```json
    {
      "symbol": "AAPL",
      "lastPrice": 227.5,
      "bids": [[227.4, 50], [227.0, 100]],
      "asks": [[227.6, 25], [228.0, 150]]
    }
    ```

- `GET /api/circuit-breakers` (Operational Circuit Breaker Status)
  - **Success Response**: Status `200 OK`
    ```json
    {
      "circuitBreakers": {
        "AAPL": { "state": "CLOSED", "referencePrice": 227.5, "lowerBand": 216.125, "upperBand": 238.875 }
      }
    }
    ```

### 3.2 WebSocket Streaming Protocol
- **Client Subscription**:
  ```json
  { "action": "subscribe", "channel": "book", "symbol": "AAPL" }
  ```
  or
  ```json
  { "type": "subscribe", "channels": ["book", "trades", "circuit_breaker"], "symbols": ["AAPL", "MSFT"] }
  ```
- **Order Book Broadcast (`book_update`)**:
  ```json
  {
    "type": "book_update",
    "symbol": "AAPL",
    "bids": [[227.4, 50]],
    "asks": [[227.6, 25]],
    "lastPrice": 227.5,
    "timestamp": 1725870000000
  }
  ```
- **Trade Execution Broadcast (`trade_execution`)**:
  ```json
  {
    "type": "trade_execution",
    "trade_id": "TRD-000001",
    "symbol": "AAPL",
    "price": 227.5,
    "qty": 25,
    "buy_order_id": "ORD-000001",
    "sell_order_id": "ORD-000002",
    "timestamp": 1725870000000
  }
  ```
- **Circuit Breaker Broadcast (`circuit_breaker`)**:
  ```json
  {
    "type": "circuit_breaker",
    "symbol": "AAPL",
    "state": "OPEN",
    "reason": "Volatility spike: 12.5% price change in 1200ms",
    "timestamp": 1725870000000
  }
  ```

---

## 4. Non-Functional Requirements
1. **Low Latency & High Throughput**:
   - Order acknowledgment p99 < 50ms (target < 5ms).
   - Throughput target > 1,000 orders/second.
   - Removal of synchronous event-loop blocking busy-wait `legacyLedgerSync` in fee calculation.
2. **Fee Calculation Invariance**:
   - Exact mathematical formula `Math.floor(qty * price * bps / 10000 + 0.4999)` with `bps = 12` must remain strictly invariant.
3. **In-Memory Concurrency & Safety**:
   - Clean data structures avoiding accidental mutation while maintaining backward-compatible module exports.
   - Idempotency locks ensuring race-free duplicate suppression.
4. **Reliability & Backward Compatibility**:
   - Existing REST clients, unit tests, and integrations must continue working without modifications.
