# Real-Time Trade Execution Engine Specification

## 1. Functional Requirements
- **Order Placement**: Accept limit and market buy/sell orders.
- **Order Matching**: Real-time matching of incoming orders against the existing order book.
- **Real-time Updates**: Stream live order book updates and trade execution details to connected clients.
- **Price-Band Circuit Breakers**: Automatically halt trading for a specific symbol if its price moves beyond a defined threshold (volatility protection).
- **Idempotency**: Prevent duplicate order placements for the same unique order request.

## 2. API Contract

### 2.1 Existing REST API (Backward Compatible)
- `POST /api/orders`
  - **Request Body**: `{ "symbol": "AAPL", "side": "buy", "qty": 100, "price": 150.0 }` (Plus optional `idempotencyKey` in body or header)
  - **Response (201)**: `{ "order_id": "ORD-000001", "status": "accepted", "fee": 15 }`
- `GET /api/orders`
  - **Response (200)**: `{ "orders": [ ... ] }`
- `GET /api/orders/:id`
  - **Response (200)**: `{ "id": "...", "symbol": "...", ... }`
- `POST /api/quote` (Deprecated but supported)
  - **Response (200)**: `{ "symbol": "...", "price": 150.0, "fee": 15 }`

### 2.2 WebSocket Streaming API (New)
- **Endpoint**: `ws://<host>:<port>/ws`
- **Messages from Server**:
  - `OrderBookUpdate`: `{ "type": "book_update", "symbol": "AAPL", "bids": [[150.0, 100], ...], "asks": [[150.5, 50], ...] }`
  - `TradeExecution`: `{ "type": "trade", "symbol": "AAPL", "price": 150.5, "qty": 50, "time": "2026-09-09T08:18:52Z" }`
- **Messages from Client**:
  - `Subscribe`: `{ "type": "subscribe", "channels": ["book", "trade"], "symbol": "AAPL" }`

## 3. Non-Functional Requirements
- **Latency**: Order acknowledgment p99 under 50ms.
- **Throughput**: Target 1000 orders/second.
- **Circuit Breakers**: Price-band circuit breakers specifically designed to handle volatile markets.
- **Idempotent Order Placement**: Safe retries without double-execution risk using an idempotency key.

## 4. Risk Constraints
- **Backward Compatibility**: Existing REST endpoints must remain strictly backward compatible (especially for partners like "hermes"). Response shapes and positional parsing must not break.
- **Storage**: In-memory storage is acceptable for this phase; no external database dependency is required.
- **Legacy Components**: The `legacyLedgerSync` blocking simulation needs to be optimized or replaced with non-blocking async IO to meet latency and throughput targets, without changing the fee numbers.
