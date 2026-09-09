#!/usr/bin/env bash
# run-tests.sh
# Run each test file in its own Node subprocess so module-level singletons
# (worker-pool, circuit-breaker emitter listeners) don't keep the event loop
# alive across file boundaries.
set -euo pipefail

PASS=0
FAIL=0
FILES=(
  test/orders.test.js
  test/idempotency.test.js
  test/circuitBreaker.test.js
  test/feeWorker.test.js
  test/api.test.js
  test/websocket.test.js
  test/latency.test.js
)

for f in "${FILES[@]}"; do
  echo "──────────────────────────────────────────"
  echo "▶  $f"
  echo "──────────────────────────────────────────"
  if node --test "$f"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "══════════════════════════════════════════"
echo "  Results: ${PASS} file(s) passed, ${FAIL} failed"
echo "══════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
