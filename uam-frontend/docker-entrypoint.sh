#!/bin/sh
# Render / production: prefer GATEWAY_INTERNAL_HOST (private network) over public onrender.com
# URLs — public proxying between Render web services causes 508 loop detected.
# Local Compose: defaults below match the `gateway` service on port 8080.
set -e

if [ -n "${GATEWAY_INTERNAL_HOST:-}" ]; then
    port="${GATEWAY_INTERNAL_PORT:-8080}"
    export GATEWAY_PROXY_BASE="http://${GATEWAY_INTERNAL_HOST}:${port}"
    export GATEWAY_PROXY_HOST="${GATEWAY_INTERNAL_HOST}"
else
    export GATEWAY_PROXY_BASE="${GATEWAY_PROXY_BASE:-http://gateway:8080}"
    export GATEWAY_PROXY_HOST="${GATEWAY_PROXY_HOST:-gateway}"
fi

# DNS server nginx uses to re-resolve the gateway hostname at runtime.
# 127.0.0.11 = Docker embedded DNS (Compose). On platforms without it (Render),
# set NGINX_RESOLVER to that platform's resolver IP.
export NGINX_RESOLVER="${NGINX_RESOLVER:-127.0.0.11}"

envsubst '${GATEWAY_PROXY_BASE} ${GATEWAY_PROXY_HOST} ${NGINX_RESOLVER}' \
    < /etc/nginx/nginx.conf.template \
    > /etc/nginx/nginx.conf

exec nginx -g 'daemon off;'
