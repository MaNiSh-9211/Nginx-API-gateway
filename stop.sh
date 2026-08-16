#!/usr/bin/env bash
# Stop the complete local stack.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/compose-common.sh"

echo "Stopping full stack..."
cd "$DEV_DIR"
docker compose "${COMPOSE_FULL[@]}" down
echo "Done."
