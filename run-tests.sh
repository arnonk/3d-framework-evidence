#!/usr/bin/env bash
# run-tests.sh
# Run the full test suite in dependency order.
# Tests for unimplemented features are expected to fail; the script reports
# a summary at the end but exits 0 so CI can inspect the full output.
#
# Usage:
#   bash run-tests.sh            # run all suites
#   bash run-tests.sh --strict   # exit non-zero if ANY test fails

set -uo pipefail

STRICT=0
for arg in "$@"; do
  [[ "$arg" == "--strict" ]] && STRICT=1
done

PASS=0
FAIL=0
SUITES=()

run_suite() {
  local label="$1"
  local file="$2"
  SUITES+=("$label")
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  $label"
  echo "════════════════════════════════════════════════════════════"
  if node --test "$file" 2>&1; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  ⚠  Suite FAILED (expected until engine is implemented)"
  fi
}

echo "▶ order-service test suite"
echo "  Node $(node --version)"
date

# ── Infrastructure (must always pass) ────────────────────────────────────────
run_suite "Market feed mock (self-tests)"    test/marketFeed.test.js

# ── Existing API compat (must pass before and after implementation) ───────────
run_suite "API backward compatibility"        test/api.test.js

# ── Unit tests (new-spec rules fail until implementation) ────────────────────
run_suite "Order validation unit tests"       test/validation.test.js
run_suite "Circuit breaker unit tests"        test/circuitBreaker.test.js

# ── Integration tests (all fail until engine is implemented) ─────────────────
run_suite "Idempotency integration"           test/idempotency.test.js
run_suite "WebSocket trade notifications"     test/websocket.test.js
run_suite "Latency regression (p99 < 50 ms)" test/latency.test.js

# ── Existing smoke test ───────────────────────────────────────────────────────
run_suite "Original orders smoke test"        test/orders.test.js

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Results: ${PASS} suite(s) passed, ${FAIL} suite(s) failed"
echo "════════════════════════════════════════════════════════════"

if [[ $STRICT -eq 1 && $FAIL -gt 0 ]]; then
  echo "  EXIT 1 (--strict mode)"
  exit 1
fi
exit 0
