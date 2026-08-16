#!/usr/bin/env bash
# Start demo-frontend (compose service: frontend-test-service) and dependencies.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/compose-common.sh"

echo "Starting demo-frontend (frontend-test-service)..."
ensure_dev_env
load_dev_env
cd "$DEV_DIR"
docker compose "${COMPOSE_TESTING[@]}" up -d --build frontend-test-service
echo "Demo app: http://localhost:${FRONTEND_TEST_PORT:-8090}"
