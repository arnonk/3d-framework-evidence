# Evidence: exp1a2-naive-pro-v2 (gemini-3.1-pro-high, naive-v2 prompt)

**Model:** gemini-3.1-pro-high | **Approach:** naive-v2 (single free-form prompt, no spec-first discipline) | **Date:** 2026-09-09 | **agy CLI:** 1.1.28

## Measured results (valid attempt, run 10:13-10:31 IDT)

| Metric | Value |
|---|---|
| Steps (DONE) | 74 |
| Input tokens | 206,509 |
| Output tokens | 15,943 |
| Thinking tokens | 9,156 |
| Cache read | 736,314 |
| **Total tokens** | **231,608** |
| Wall time | 18.4 min |
| Errors | 0 |
| Tests | 5/5 pass |
| Workspace discipline | all file writes inside the condition workspace (verified from stream log TargetFile params) |

Outcome: in-place integration. New service executionEngine.js; new tests execution.test.js + idempotency.test.js; modified index.js, orders.js, orderService.js, package.json.

## Invalidated earlier attempts (logged for honesty)

- Attempt 1 (2026-09-08): agent abandoned the target workspace and worked in an unrelated leftover decoy repo. 76 steps, ~177k tokens. Confounded - not a measurement.
- Attempt 2 (2026-09-09 09:46-10:06): agent discovered the evidence repo's pristine scaffold copy at /tmp/evidence-repo (a second package.json on the machine, an artifact of the evidence-sync infrastructure) and did the whole task there. 85 steps, ~304k tokens. Confounded - not a measurement. Branch deleted and rerun.

**Pattern (article-relevant): both naive attempts that could find a second package.json on the machine wandered into it (2/2). The spec-driven condition never did. With a sanitized environment, naive-v2 completes in-workspace.**

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
