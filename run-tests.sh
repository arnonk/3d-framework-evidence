#!/usr/bin/env bash
# run-tests.sh
# Runs each test file as a separate node process so no module-singleton state
# (wsHub, orderBook, feePool, circuitBreaker) leaks between suites.
set -euo pipefail

FILES=(
  test/circuitBreaker.test.js
  test/feePool.test.js
  test/idempotency.test.js
  test/orders.test.js
  test/integration.test.js
  test/websocket.test.js
)

PASS=0
FAIL=0

for f in "${FILES[@]}"; do
  echo "▶ $f"
  if node --test "$f"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "suites passed: $PASS  failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
