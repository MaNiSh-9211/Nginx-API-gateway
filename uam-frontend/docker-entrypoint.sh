#!/bin/sh
# Render / production: prefer GATEWAY_INTERNAL_HOST (private network) over public onrender.com
# URLs — public proxying between Render web services causes 508 loop detected.
# Local Compose: defaults below match the `gateway` service on port 8080.
set -e

if [ -n "${GATEWAY_INTERNAL_HOST:-}" ]; then
    port="${GATEWAY_INTERNAL_PORT:-8080}"
    export GATEWAY_PROXY_PASS="http://${GATEWAY_INTERNAL_HOST}:${port}/api/"
    export GATEWAY_PROXY_HOST="${GATEWAY_INTERNAL_HOST}"
else
    export GATEWAY_PROXY_PASS="${GATEWAY_PROXY_PASS:-http://gateway:8080/api/}"
    export GATEWAY_PROXY_HOST="${GATEWAY_PROXY_HOST:-gateway}"
fi

envsubst '${GATEWAY_PROXY_PASS} ${GATEWAY_PROXY_HOST}' \
    < /etc/nginx/nginx.conf.template \
    > /etc/nginx/nginx.conf

exec nginx -g 'daemon off;'
