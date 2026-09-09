# Evidence: exp2a-naive-flash (gemini-3.7-flash-high, naive-v2 prompt)

**Model:** gemini-3.7-flash-high | **Approach:** naive-v2 (single free-form prompt, no spec-first discipline requested) | **Date:** 2026-09-09 | **agy CLI:** 1.1.28

## Measured results (run 10:36-10:52 IDT)

| Metric | Value |
|---|---|
| Steps (DONE) | 135 |
| Input tokens | 356,242 |
| Output tokens | 67,470 |
| Thinking tokens | 26,742 |
| Cache read | 3,039,462 |
| **Total tokens** | **450,454** |
| Wall time | 15.3 min |
| Errors | 0 |
| Tests | 35/35 pass |
| Workspace discipline | all writes inside the condition workspace (verified) |

Outcome: in-place integration - new circuitBreakerService.js, idempotencyService.js, wsService.js; modified config/index/models/routes/services; package.json extended.

**Notable: despite the naive prompt (no spec-first instruction), the agent spontaneously wrote SPEC.md and TASKS.md before implementing - it self-imposed the discipline artifacts. It also wrote far more tests (35) than any other condition.**

## Verbatim prompt (naive-v2)

```
This repository contains our internal order routing service (Express, in-memory). It has grown organically since 2022 and has some legacy quirks: shared mutable state in the order book, callback-style routes, a blocking busy-wait in the fee calculation that we can't remove without changing fee amounts, and a deprecated /api/quote endpoint that a partner still calls.

Extend it into a real-time trade execution engine that optimizes order execution for volatile markets. Requirements:
- Keep the existing REST API working - external partners depend on the current response shapes, especially POST /api/orders and the deprecated /api/quote.
- Add real-time order book updates and trade execution notifications over WebSocket.
- Order placement must be idempotent - clients retry on timeouts and we cannot double-execute.
- Add price-band circuit breakers so a volatility spike pauses execution instead of spraying orders into a moving market.
- Order acknowledgment should be fast (p99 under 50ms). The fee calc busy-wait probably needs attention, but fee amounts must not change.
- Write tests for the new behavior and make sure the existing test suite still passes.

Take your time, be thorough, and build this properly.
```
