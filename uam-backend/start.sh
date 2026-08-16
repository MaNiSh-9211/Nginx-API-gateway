#!/usr/bin/env bash
# Start uam-backend and dependencies (mongodb, redis, gateway base).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/compose-common.sh"

echo "Starting uam-backend..."
ensure_dev_env
cd "$DEV_DIR"
docker compose "${COMPOSE_UAM[@]}" up -d --build uam-backend
echo "UAM backend healthy on internal network (via gateway /api/auth)."
