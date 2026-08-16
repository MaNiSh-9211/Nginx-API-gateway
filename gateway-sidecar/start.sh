#!/usr/bin/env bash
# Start gateway-sidecar (compose service: config-sidecar) and dependencies.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/compose-common.sh"

echo "Starting gateway-sidecar (config-sidecar)..."
ensure_dev_env
cd "$DEV_DIR"
docker compose "${COMPOSE_BASE[@]}" up -d --build config-sidecar
echo "Sidecar polls control-plane and writes gateway config."
