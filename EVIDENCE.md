# Evidence: exp2b-spec-flash (gemini-3.7-flash-high, spec-driven 3-phase)

**Model:** gemini-3.7-flash-high | **Approach:** spec-driven (3-phase) | **Date:** 2026-09-09 | **agy CLI:** 1.1.28

## Measured results (run 10:57-11:22 IDT)

| Phase | Steps | Input | Output | Thinking | Cache read | Wall |
|---|---|---|---|---|---|---|
| b1-architect | 81 | 247,627 | 20,338 | 6,391 | 919,927 | 5.6 min |
| b2-sdet | 33 | 64,456 | 15,231 | 5,044 | 917,521 | 4.8 min |
| b3-implement | 74 | 203,813 | 27,762 | 13,957 | 3,013,059 | 14.9 min |
| **Total** | **188** | **515,896** | **63,331** | **25,392** | **4,850,507** | **25.4 min** |

- Tests: **29/29 pass**; Errors: 0
- Outcome: in-place integration - new matchingEngine.js (models), circuitBreaker.js, idempotencyService.js, websocketService.js (services); circuitBreaker tests + more; all writes inside the condition workspace (verified)
- SPEC.md + TASKS.md produced in b1; mocks-first tests in b2; task-by-task implementation in b3

## Verbatim phase prompts

### b1-architect
```
Goal: build a real-time trade execution engine that optimizes order execution for volatile markets, as an extension of the service in this repository. Act as the lead architect. Do NOT write or modify any application code in this phase. First inspect the repository, then write SPEC.md containing: functional requirements; an API contract (existing REST plus WebSocket streaming of order book updates and trade executions); non-functional requirements (order acknowledgment p99 under 50ms, throughput target 1000 orders/sec, price-band circuit breakers for volatile markets, idempotent order placement); and risk constraints (existing REST endpoints stay backward compatible, in-memory storage is acceptable). Then write TASKS.md: an ordered task list where each task names the exact files it will create or modify and is independently verifiable.
```

### b2-sdet
```
Act as a senior SDET. Read SPEC.md and TASKS.md in this repository. Before any implementation exists, write the test suite and mocks for the real-time trade execution engine: a deterministic in-memory mock market-feed generator with configurable volatility spikes; unit tests for order validation and the price-band circuit breakers; and integration tests for idempotent order placement and WebSocket trade notifications. Extend the existing test setup (node --test). Do not implement the engine itself - the new tests are expected to fail at this stage.
```

### b3-implement
```
Implement TASKS.md task by task, in order. For each task: touch only the files that task names, then run the relevant tests. Continue until all tasks are complete and the full test suite passes. Keep the existing REST API backward compatible.
```
