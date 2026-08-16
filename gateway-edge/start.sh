#!/usr/bin/env bash
# Start gateway-edge (compose service: gateway) and its dependencies.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/compose-common.sh"

echo "Starting gateway-edge (gateway)..."
ensure_dev_env
load_dev_env
cd "$DEV_DIR"
docker compose "${COMPOSE_FULL[@]}" up -d --build gateway
echo "Gateway: http://localhost:${GATEWAY_PORT:-18083}"
