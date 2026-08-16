#!/usr/bin/env bash
# Start the complete local stack (gateway + demo + UAM + monitoring).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/compose-common.sh"

echo "Starting full API gateway stack..."
ensure_dev_env
cd "$DEV_DIR"
docker compose "${COMPOSE_FULL[@]}" up -d --build

echo ""
echo "Waiting for core health checks..."
sleep 5
docker compose "${COMPOSE_FULL[@]}" ps

print_stack_urls
