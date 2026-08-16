#!/usr/bin/env bash
# Start demo-backend (compose service: backend-test-service) and dependencies.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/compose-common.sh"

echo "Starting demo-backend (backend-test-service)..."
ensure_dev_env
cd "$DEV_DIR"
docker compose "${COMPOSE_TESTING[@]}" up -d --build backend-test-service
echo "Sample API upstream registered on gateway internal aliases."
