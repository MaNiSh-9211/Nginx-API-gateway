#!/usr/bin/env bash
# Start uam-frontend and dependencies (uam-backend, gateway).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/compose-common.sh"

echo "Starting uam-frontend..."
ensure_dev_env
load_dev_env
cd "$DEV_DIR"
docker compose "${COMPOSE_UAM[@]}" up -d --build uam-frontend
echo "UAM app: http://localhost:${UAM_FRONTEND_PORT:-8091}"
