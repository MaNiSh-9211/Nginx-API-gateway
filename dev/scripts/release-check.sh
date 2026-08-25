#!/usr/bin/env bash
# Pre-release validation — Linux/macOS parity with scripts/release-check.ps1
# Usage: ./scripts/release-check.sh [--skip-e2e]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SKIP_E2E=0
[[ "${1:-}" == "--skip-e2e" ]] && SKIP_E2E=1

fail=0

step() {
  local name="$1"
  shift
  echo ""
  echo ">> $name"
  if "$@"; then
    echo "   OK"
  else
    echo "   FAIL"
    fail=$((fail + 1))
  fi
}

echo "Release gate - routiq"

step "gateway-edge rust-ext unit tests" bash -c 'cd gateway-edge/rust-ext && cargo test --release -q'
step "gateway-control-plane unit tests" bash -c 'cd gateway-control-plane && cargo test --release -q'
step "gateway-sidecar unit tests" bash -c 'cd gateway-sidecar && cargo test --release -q'
step "docker compose validate" bash -c 'cd dev && docker compose -f docker-compose.yml config --quiet'
step "multi-region compose validate" bash -c 'cd dev && docker compose -f docker-compose.multi-region.yml config --quiet'

helm_lint() {
  local args=(template api-gateway platform/deploy/helm/api-gateway
    --set secrets.jwtSecret=test --set secrets.adminApiKey=test)
  if command -v helm >/dev/null 2>&1; then
    helm "${args[@]}" >/dev/null
  else
    echo "   (helm not on PATH; using alpine/helm container)"
    docker run --rm -v "$ROOT:/work" -w /work alpine/helm:3.14.4 "${args[@]}" >/dev/null
  fi
}
step "helm template lint" helm_lint

step "docker compose validate (UAM stack)" bash -c 'cd dev && docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml config --quiet'

if [[ "$SKIP_E2E" -eq 0 ]]; then
  if [[ -f dev/tests/e2e.sh ]]; then
    step "E2E smoke (dev/tests/e2e.sh)" bash dev/tests/e2e.sh
  else
    echo ">> E2E skipped (dev/tests/e2e.sh not found)"
  fi
fi

total=$((SKIP_E2E == 0 ? 8 : 7))
echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "Release gate PASSED ($total checks)"
  exit 0
else
  echo "Release gate FAILED: $fail of $total checks"
  exit 1
fi
