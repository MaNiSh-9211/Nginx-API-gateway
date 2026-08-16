#!/usr/bin/env bash
# Bootstrap .env.dev from .env.example (gitignored secrets file).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

copy_if_missing() {
    local dir="$1"
    local example="$dir/.env.example"
    local dev="$dir/.env.dev"
    if [[ -f "$dev" ]]; then
        echo "  skip $dev (exists)"
        return
    fi
    if [[ ! -f "$example" ]]; then
        return
    fi
    cp "$example" "$dev"
    echo "  created $dev from .env.example — edit with real credentials"
}

echo "=== Bootstrap .env.dev (secrets, gitignored) ==="
copy_if_missing "$ROOT/dev"
for svc in gateway-edge gateway-control-plane gateway-sidecar gateway-redis \
    uam-backend uam-frontend demo-backend demo-frontend; do
    copy_if_missing "$ROOT/$svc"
done

echo ""
echo "Edit dev/.env.dev with MONGODB_URI (Atlas) and any OAuth/SMTP secrets."
echo "Safe defaults in committed .env files are used when .env.dev keys are unset."
