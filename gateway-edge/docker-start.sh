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

# ── mTLS includes (ADR-0067, gap #6) ─────────────────────────────────────
# Always emitted (possibly empty) so nginx.conf can include them unconditionally.
#
# CLIENT-cert verification (browsers/clients → gateway), env-gated:
#   MTLS_CLIENT_VERIFY=on|optional   +  MTLS_CLIENT_CA_FILE=/path/ca.crt
UPSTREAM_MTLS_BLOCK="/etc/nginx/upstream_mtls.conf"
CLIENT_MTLS_BLOCK="/etc/nginx/client_mtls.conf"
: > "$UPSTREAM_MTLS_BLOCK"
: > "$CLIENT_MTLS_BLOCK"

if [ -n "${MTLS_CLIENT_VERIFY:-}" ] && [ -n "${MTLS_CLIENT_CA_FILE:-}" ]; then
    cat > "$CLIENT_MTLS_BLOCK" <<EOF
ssl_client_certificate ${MTLS_CLIENT_CA_FILE};
ssl_verify_client ${MTLS_CLIENT_VERIFY};
ssl_verify_depth 2;
EOF
    echo "gateway: client mTLS enabled (verify=${MTLS_CLIENT_VERIFY})"
fi

# UPSTREAM mTLS (gateway → backends), env-gated:
#   UPSTREAM_MTLS_CERT / UPSTREAM_MTLS_KEY / optional UPSTREAM_MTLS_CA_FILE
if [ -n "${UPSTREAM_MTLS_CERT:-}" ] && [ -n "${UPSTREAM_MTLS_KEY:-}" ]; then
    {
        echo "proxy_ssl_certificate ${UPSTREAM_MTLS_CERT};"
        echo "proxy_ssl_certificate_key ${UPSTREAM_MTLS_KEY};"
        echo "proxy_ssl_server_name on;"
        if [ -n "${UPSTREAM_MTLS_CA_FILE:-}" ]; then
            echo "proxy_ssl_trusted_certificate ${UPSTREAM_MTLS_CA_FILE};"
            echo "proxy_ssl_verify on;"
            echo "proxy_ssl_verify_depth 2;"
        fi
    } > "$UPSTREAM_MTLS_BLOCK"
    echo "gateway: upstream mTLS client cert configured"
fi

echo "gateway: starting OpenResty"
exec "$OPENRESTY" -g 'daemon off;'
