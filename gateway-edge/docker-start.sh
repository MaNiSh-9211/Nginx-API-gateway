#!/bin/sh
# Single-container Render/K8s pattern: config-sidecar + OpenResty gateway (ADR-0052).
set -e

echo "=== RENDER ENV VARS ==="
env | grep RENDER || true
echo "======================="
CONFIG_PATH="${GATEWAY_CONFIG_PATH:-/etc/gateway/config.json}"
OPENRESTY="/usr/local/openresty/bin/openresty"
SIDECAR="/usr/local/bin/config-sidecar"

echo "gateway: starting config-sidecar → ${CONFIG_PATH}"
config-sidecar &
SIDECAR_PID=$!

echo "gateway: waiting for initial config from control-plane..."
i=0
while [ ! -s "$CONFIG_PATH" ]; do
    i=$((i + 1))
    if [ "$i" -gt 90 ]; then
        echo "gateway: timeout waiting for ${CONFIG_PATH}" >&2
        kill "$SIDECAR_PID" 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

echo "gateway: config ready, starting OpenResty"
exec "$OPENRESTY" -g 'daemon off;'
