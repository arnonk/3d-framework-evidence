# Evidence: exp3a-naive-claude (claude-sonnet-4-6, naive-v2)

**Model:** claude-sonnet-4-6 | **Approach:** naive-v2 (one-shot) | **Date:** 2026-09-09 | **agy CLI:** 1.1.28

## Measured results (clean run: attempt 4, 17:15-22:00 IDT)

| Steps | Input | Output | Thinking | Cache read | Total | Wall |
|---|---|---|---|---|---|---|
| 291 (21 transient-error steps) | 693,898 | 56,823 | 0 | 7,944,445 | 750,721 | 4h44m total, ~1h50m active (2h54m quota stall, see below) |

- Tests: **59/59 pass** across 7 test files (includes the 3 baseline tests; verified independently after the run)
- Run exit status: agy reported `ERROR` despite a complete final summary - the status reflects 21 transient API error markers (network resets + the quota wall), not a task failure. The final agent message (a full implementation summary) completed normally.
- Outcome: in-place integration - execution engine, price-band circuit breakers with admin endpoints, idempotency store, WebSocket hub with subscribe/filter channels, fee busy-wait moved to a worker. Existing REST response shapes preserved (per the agent's own summary and test results).

## Notable agent behavior (observed, not graded)

- Spontaneously decomposed the task via subagents (`manage_task` x15, `schedule` x8): spawned a "trade-engine-builder" subagent and polled it on a self-set timer. Subagent work runs in-process; its tokens are included in the totals above.
- The run's own `node --test` invocations hung twice on non-terminating event loops (open handles). The orchestrator killed the hung test processes (0% CPU, 3+ min) so the agent's command returned and it could react. Both kills are logged in `logs/exp3a-naive-claude.interventions.log`. This is environment maintenance, not assistance: the hang outcomes were visible to the agent as data.
- Two transient `connection reset by peer` API errors (14:46/14:56 pattern repeated); agy retried automatically.

## Attempt history (honest confound/failure log)

1. **Attempt 1** (11:27-12:38 IDT): orchestrator sandbox was rebuilt mid-run; run lost. Progress commits preserved on this branch.
2. **Attempt 2** (14:32-15:09 IDT): Claude pool quota exhausted (429 RESOURCE_EXHAUSTED) at step 100, ~37 min in. Also, in the first minute the agent READ a stray pristine scaffold clone at /home/sandbox/evidence (reads only, byte-identical content; the clone was immediately removed). Quota-killed, workspace preserved in Drive.
3. **Attempt 3** (16:35-17:05 IDT): CONFOUNDED - the agent drifted into a sibling pristine condition dir (`exp3b-spec-claude`, mistakenly left visible by the orchestrator) and implemented the engine there; status ERROR, 64 steps, 155,536 tokens. Environment fault, not a fair data point. The drifted workspace is preserved in Drive as `exp3a-attempt3-drifted-workspace-CONFOUND-*.tar.gz`.
4. **Attempt 4** (17:15-22:00 IDT): CLEAN. Sanitized filesystem (no stray dirs). At step 202 (18:50) the Claude pool quota was exhausted; the agy process was left alive and auto-resumed the SAME conversation at ~21:35 when quota reset. No state lost. Wall-clock annotated active vs stalled above.

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
