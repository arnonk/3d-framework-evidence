# Task Implementation Plan

## Task 1: Setup WebSocket Infrastructure
- **Modify**: `package.json` (add `ws` library dependency)
- **Modify**: `src/index.js` (attach WebSocket server to the HTTP server)
- **Create**: `src/services/wsService.js` (handle client connections, subscriptions, and broadcasting)
- **Goal**: Establish the basic `/ws` endpoint for clients to connect and subscribe to channels.

## Task 2: Remove Blocking Legacy Code for Performance
- **Modify**: `src/services/orderService.js` 
  - Refactor `legacyLedgerSync(30)` to use asynchronous non-blocking delays (e.g., `setTimeout`), or remove the artificial block completely while preserving the existing fee calculation logic.
- **Goal**: Unblock the Node.js event loop to achieve the p99 latency < 50ms and 1000 orders/sec throughput targets.

## Task 3: Implement Idempotent Order Placement
- **Modify**: `src/routes/orders.js` (extract idempotency key from request and pass to service)
- **Modify**: `src/services/orderService.js` (check for existing idempotency key before placing order)
- **Modify**: `src/models/orderBook.js` (store idempotency keys mapped to order IDs)
- **Goal**: Ensure that repeated POST requests with the same idempotency key return the previously generated order without creating a new duplicate order.

## Task 4: Implement Price-Band Circuit Breakers
- **Create**: `src/services/circuitBreaker.js` (track price movements and manage trading halt states per symbol based on volatility bands)
- **Modify**: `src/services/orderService.js` (check circuit breaker status before accepting an order; reject with a relevant error if halted)
- **Goal**: Protect the engine against extreme market volatility by rejecting orders for a symbol if its price moves beyond configured bands.

## Task 5: Implement Order Matching Engine
- **Modify**: `src/models/orderBook.js` (upgrade the data structure to maintain sorted bids and asks instead of an append-only array of orders)
- **Create**: `src/services/matchingEngine.js` (match crossing buy/sell limit and market orders and generate trade executions)
- **Modify**: `src/services/orderService.js` (route new orders to the matching engine)
- **Goal**: Enable real-time matching of incoming orders against the resting limit orders in the book.

## Task 6: Stream Market Data and Executions
- **Modify**: `src/services/matchingEngine.js` (emit events for executed trades and order book updates)
- **Modify**: `src/services/wsService.js` (listen to matching engine events and broadcast them to subscribed WebSocket clients)
- **Goal**: Deliver `OrderBookUpdate` and `TradeExecution` messages to clients with active subscriptions.
