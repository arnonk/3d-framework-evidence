# SPEC — Real-Time Trade Execution Engine
**Extension of `order-service` v1.2.0**
_Status: DRAFT · Last updated: 2026-09-09_

---

## 1. Background & Scope

`order-service` is an Express/Node.js in-memory order-routing prototype that exposes a synchronous REST API. It has two known technical liabilities that block production use at scale:

1. **Blocking fee computation** — `legacyLedgerSync(30)` spin-loops for 30 ms on every `placeOrder`, monopolising the event loop.
2. **No real-time feed** — callers must poll `GET /api/orders` to discover fills; unsuitable for volatile markets.

This spec describes the work required to evolve `order-service` into a **real-time trade execution engine** that meets the performance, reliability, and market-safety targets below, without breaking existing integrations.

---

## 2. Functional Requirements

### FR-1 · Order Placement
| ID | Requirement |
|----|-------------|
| FR-1.1 | `POST /api/orders` MUST continue to accept the existing request shape (`symbol`, `side`, `qty`, `price`) and return `{ order_id, status, fee }` — shape is immutable (backward-compat). |
| FR-1.2 | Callers MAY supply an `idempotency_key` (string, ≤ 128 chars) in the request body. Two requests with the same key for the same symbol+side+qty+price MUST return the identical response as the first, without placing a duplicate order. Idempotency keys are scoped to 24 hours. |
| FR-1.3 | On placement, the service MUST assign the order the status `accepted` and MUST broadcast a `trade_execution` WebSocket event (see §4.2) to all connected subscribers for the order's symbol. |
| FR-1.4 | Fee computation MUST be performed asynchronously (event-loop non-blocking). The fee algorithm and its historical rounding rule (`Math.floor(qty * price * bps / 10000 + 0.4999)`) MUST be preserved exactly; `legacyLedgerSync` MUST be removed. |
| FR-1.5 | Quantity MUST NOT exceed `maxOrderQty` (currently 10 000). Price MUST be a positive finite number. `side` MUST be `buy` or `sell`. |

### FR-2 · Order Retrieval
| ID | Requirement |
|----|-------------|
| FR-2.1 | `GET /api/orders` returns all in-memory orders (shape unchanged: `{ orders: [ {id, symbol, side, qty, price, status} ] }`). |
| FR-2.2 | `GET /api/orders/:id` returns the single order object or 404 (shape unchanged). |
| FR-2.3 | Both list endpoints MUST support an optional `?symbol=` query filter. |

### FR-3 · Deprecated Quote Endpoint
| ID | Requirement |
|----|-------------|
| FR-3.1 | `POST /api/quote` MUST remain functional and return the same response shape (`{ symbol, price, fee }`). It MUST NOT be removed. Its internals MAY be refactored as long as observable behaviour is unchanged. |

### FR-4 · Health & Observability
| ID | Requirement |
|----|-------------|
| FR-4.1 | `GET /api/health` MUST return `{ status, ts }`. It MUST be extended to include `{ …, circuit_breakers: { [symbol]: "open" | "closed" }, ws_connections: <number> }`. |
| FR-4.2 | Every order event (placed, rejected, circuit-breaker trip) MUST produce a structured JSON log line containing at minimum: `ts`, `event`, `order_id` (or `null`), `symbol`, `latency_ms`. |

### FR-5 · Order Book Feed
| ID | Requirement |
|----|-------------|
| FR-5.1 | On connection, the WebSocket server MUST send a `book_snapshot` message containing all open orders for all symbols, or for a single symbol if the client subscribed with `{ type: "subscribe", symbol: "AAPL" }`. |
| FR-5.2 | Whenever any order is placed or its status changes, a `book_update` message MUST be broadcast to all subscribers of that symbol (and to any client subscribed to `*`). |
| FR-5.3 | Clients that subscribe to a symbol while a circuit breaker is open for that symbol MUST immediately receive a `circuit_breaker` event indicating the open state. |

### FR-6 · Circuit Breakers
| ID | Requirement |
|----|-------------|
| FR-6.1 | Each symbol has an independent circuit breaker. |
| FR-6.2 | A breaker **trips open** when the last-seen trade price for that symbol moves more than `BAND_PCT` percent (default: 5 %) from the reference price within a rolling window of `BAND_WINDOW_MS` milliseconds (default: 60 000 ms). |
| FR-6.3 | While a breaker is open, `POST /api/orders` for that symbol MUST be rejected with HTTP 422 and body `{ error: "circuit breaker open", symbol, reference_price, band_pct }`. |
| FR-6.4 | A breaker **resets to closed** automatically after `BREAKER_RESET_MS` milliseconds (default: 30 000 ms) since it was tripped, OR when an operator calls `DELETE /api/circuit-breakers/:symbol`. |
| FR-6.5 | `GET /api/circuit-breakers` returns current state of all breakers: `{ [symbol]: { state: "open"|"closed", tripped_at: <iso>|null, reference_price: <number>|null } }`. |
| FR-6.6 | Breaker trip and reset events MUST be broadcast over WebSocket to subscribers of the affected symbol. |

### FR-7 · Price Feed Ingestion
| ID | Requirement |
|----|-------------|
| FR-7.1 | `pricingService` MUST expose a `setPrice(symbol, price)` function that updates the last-known price and feeds the circuit-breaker evaluation pipeline. |
| FR-7.2 | An internal `POST /api/prices` endpoint (internal-only; no auth required in this phase) allows test harnesses and future market-data adapters to push price updates: `{ symbol: string, price: number }`. Responds `200 { ok: true }`. |
| FR-7.3 | `symbols()` MUST return all symbols that have received at least one price update, not just the static list. |

---

## 3. API Contract

### 3.1 Existing REST Endpoints (backward-compatible, immutable shapes)

#### `POST /api/orders`
```
Request body:
{
  "symbol":          "AAPL",          // string, required
  "side":            "buy",           // "buy" | "sell", required
  "qty":             100,             // number > 0, ≤ maxOrderQty
  "price":           227.50,          // number > 0
  "idempotency_key": "uuid-v4-..."    // string ≤ 128 chars, optional
}

201 Created:
{
  "order_id": "ORD-000001",
  "status":   "accepted",
  "fee":      27                      // integer, same rounding as today
}

400 Bad Request:    { "error": "<validation message>" }
422 Unprocessable:  { "error": "circuit breaker open", "symbol": "AAPL",
                      "reference_price": 227.5, "band_pct": 5 }
500 Internal:       { "error": "<message>" }
```
> ⚠️ The three-field response shape (`order_id`, `status`, `fee`) MUST NOT change. Partner "hermes" parses these fields positionally.

#### `GET /api/orders`
```
200 OK:
{
  "orders": [
    { "id": "ORD-000001", "symbol": "AAPL", "side": "buy",
      "qty": 100, "price": 227.5, "status": "accepted" }
  ]
}
```
Optional query param: `?symbol=AAPL`

#### `GET /api/orders/:id`
```
200 OK:  <order object>
404:     { "error": "order not found" }
```

#### `POST /api/quote` _(deprecated, must not be removed)_
```
Request:  { "symbol": "AAPL", "qty": 100 }
200 OK:   { "symbol": "AAPL", "price": 227.5, "fee": 27 }
500:      { "error": "unknown symbol" }
```

#### `GET /api/health`
```
200 OK:
{
  "status": "up",
  "ts": 1725912345678,
  "circuit_breakers": { "AAPL": "closed", "TSLA": "open" },
  "ws_connections": 4
}
```

---

### 3.2 New REST Endpoints

#### `GET /api/circuit-breakers`
```
200 OK:
{
  "AAPL": { "state": "closed", "tripped_at": null,                 "reference_price": 227.5  },
  "TSLA": { "state": "open",   "tripped_at": "2026-09-09T19:01:00Z","reference_price": 248.9 }
}
```

#### `DELETE /api/circuit-breakers/:symbol`
```
200 OK:  { "ok": true, "symbol": "AAPL" }
404:     { "error": "unknown symbol" }
```

#### `POST /api/prices` _(internal)_
```
Request:  { "symbol": "AAPL", "price": 229.0 }
200 OK:   { "ok": true }
400:      { "error": "<validation message>" }
```

---

### 3.3 WebSocket API

**Transport:** WebSocket, same port as HTTP, path `/ws`.

#### Connection Lifecycle
```
Client connects to ws://<host>:<port>/ws
Server immediately sends: book_snapshot (§3.3.2)
Client optionally sends:  subscribe (§3.3.1)
Server sends events:      book_update | trade_execution | circuit_breaker | error
```

#### 3.3.1 Client → Server Messages

```jsonc
// Subscribe to a specific symbol (or all symbols with "*")
{ "type": "subscribe", "symbol": "AAPL" }

// Unsubscribe
{ "type": "unsubscribe", "symbol": "AAPL" }

// Ping (server echoes pong)
{ "type": "ping" }
```

#### 3.3.2 Server → Client Messages

**`book_snapshot`** — sent once on connect (or after symbol subscribe):
```jsonc
{
  "type":    "book_snapshot",
  "symbol":  "AAPL",           // or "*" for all
  "ts":      1725912345678,
  "bids":    [ { "price": 227.5, "qty": 100 }, … ],
  "asks":    [ { "price": 227.6, "qty": 50  }, … ]
}
```

**`book_update`** — incremental change to the order book:
```jsonc
{
  "type":     "book_update",
  "symbol":   "AAPL",
  "ts":       1725912345678,
  "side":     "buy",
  "price":    227.5,
  "qty":      100,
  "action":   "add" | "remove" | "update"
}
```

**`trade_execution`** — emitted when an order is accepted:
```jsonc
{
  "type":     "trade_execution",
  "order_id": "ORD-000001",
  "symbol":   "AAPL",
  "side":     "buy",
  "qty":      100,
  "price":    227.5,
  "fee":      27,
  "status":   "accepted",
  "ts":       1725912345678
}
```

**`circuit_breaker`** — emitted on trip or reset:
```jsonc
{
  "type":            "circuit_breaker",
  "symbol":          "TSLA",
  "state":           "open" | "closed",
  "reference_price": 248.9,
  "current_price":   261.4,
  "band_pct":        5,
  "ts":              1725912345678
}
```

**`error`** — in response to invalid client messages:
```jsonc
{ "type": "error", "message": "unknown message type" }
```

**`pong`**:
```jsonc
{ "type": "pong", "ts": 1725912345678 }
```

---

## 4. Non-Functional Requirements

### NFR-1 · Latency
| Metric | Target |
|--------|--------|
| `POST /api/orders` p99 end-to-end (request received → 201 response sent) | **< 50 ms** |
| WebSocket event delivery (order accepted → `trade_execution` received by connected client) | < 10 ms |
| `GET /api/orders` p99 | < 5 ms |

> **Root cause of current latency violation:** `legacyLedgerSync(30)` blocks the event loop for ≥ 30 ms synchronously on every order. It MUST be replaced with an asynchronous, non-blocking equivalent that preserves the fee formula.

### NFR-2 · Throughput
| Metric | Target |
|--------|--------|
| Sustained order ingestion | **≥ 1 000 orders/sec** (measured at p95 over a 30-second window) |
| Concurrent WebSocket clients | ≥ 100 without degrading order latency |

### NFR-3 · Idempotency
- Duplicate `POST /api/orders` requests carrying the same `idempotency_key` (within a 24-hour TTL window) MUST return HTTP 200 with the original response body, without side effects.
- Requests lacking `idempotency_key` are non-idempotent by design (existing behaviour preserved).
- The idempotency store is in-memory; it is acceptable for it to be wiped on restart.

### NFR-4 · Circuit Breaker Safety
- Price-band evaluation MUST occur synchronously on the hot path of `POST /api/orders` before any order is written — a breaker that is open MUST prevent the write, not just log a warning.
- Breaker configuration (`BAND_PCT`, `BAND_WINDOW_MS`, `BREAKER_RESET_MS`) MUST be readable from environment variables, with the defaults specified in §2 (FR-6).
- Breaker state MUST be consistent across all in-process request handlers (i.e., a single shared in-memory store is sufficient).

### NFR-5 · Backward Compatibility
- All existing REST endpoint paths, HTTP methods, response shapes, and HTTP status codes MUST remain unchanged.
- The deprecated `POST /api/quote` MUST continue to function.
- No existing fields may be removed or renamed in any existing response body.
- New optional fields MAY be added to existing response bodies only if they do not break positional parsers (i.e., new fields should be appended, not inserted).

### NFR-6 · Reliability & Graceful Shutdown
- On `SIGTERM`, the server MUST stop accepting new connections, drain in-flight HTTP requests, and close all WebSocket connections with close code 1001 (going away) before exiting.
- No order placement that received HTTP 201 may be lost due to shutdown (in-memory guarantee only; disk persistence is out of scope).

### NFR-7 · Observability
- Structured JSON logs (newline-delimited) to stdout. Each line includes: `ts` (ISO-8601), `level`, `event`, `order_id`, `symbol`, `latency_ms`.
- A `latency_ms` field MUST be present on every order-placement log line.
- Log level is controlled by `LOG_LEVEL` env var (default: `info`).

---

## 5. Risk Constraints

| Risk | Constraint |
|------|-----------|
| Breaking partner "hermes" | `POST /api/orders` response shape frozen: `{ order_id, status, fee }` only. No field reordering, renaming, or removal. |
| Breaking partner "hermes" (quote) | `POST /api/quote` must remain at the same path and return the same shape indefinitely. |
| In-memory storage restart wipe | Acceptable. No persistence layer is required. Idempotency keys and circuit-breaker state may be wiped on restart. |
| Cascading breaker failure | Each symbol's breaker is fully independent. A bug in one breaker MUST NOT affect order placement for other symbols. |
| Event-loop blocking regression | CI MUST include a latency regression test that fails if p99 of 500 sequential `POST /api/orders` exceeds 50 ms. |
| Node.js single-threaded WebSocket broadcast | Broadcasts MUST be synchronous in-process fan-out to all connected sockets; no external message bus required in v1. |
| Idempotency store memory growth | The store MUST evict keys older than 24 hours. A periodic sweep (e.g., every 5 minutes) is acceptable. |

---

## 6. Configuration Reference

All configuration is resolved at startup from environment variables with the defaults shown. No hot-reload.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP/WS listen port |
| `NODE_ENV` | `development` | Runtime environment label |
| `MAX_ORDER_QTY` | `10000` | Maximum order quantity |
| `DEFAULT_FEE_BPS` | `12` | Fee in basis points |
| `BAND_PCT` | `5` | Price-band % for circuit breaker |
| `BAND_WINDOW_MS` | `60000` | Rolling window for price-band evaluation (ms) |
| `BREAKER_RESET_MS` | `30000` | Auto-reset delay after a breaker trips (ms) |
| `LOG_LEVEL` | `info` | Log verbosity (`debug`/`info`/`warn`/`error`) |

---

## 7. Assumptions & Out of Scope

- **Authentication / authorisation** — out of scope for this phase.
- **TLS** — out of scope; handled by the load balancer.
- **Disk persistence** — explicitly out of scope; in-memory is sufficient.
- **Multi-process / clustering** — out of scope; single Node.js process is the target deployment.
- **Order matching / fills** — this service is a routing layer; matching is done downstream. Orders stay in `accepted` state. Status transitions (`filled`, `cancelled`) are out of scope.
- **Market-data adapter** — `POST /api/prices` is the integration point; the external feed client is out of scope.
