#!/usr/bin/env bash
# Start gateway-control-plane (compose service: control-plane) and dependencies.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/compose-common.sh"

echo "Starting gateway-control-plane (control-plane)..."
ensure_dev_env
load_dev_env
cd "$DEV_DIR"
docker compose "${COMPOSE_BASE[@]}" up -d --build control-plane
echo "Control plane: http://localhost:${CONTROL_PLANE_PORT:-18085}"
