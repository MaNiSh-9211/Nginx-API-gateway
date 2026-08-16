#!/bin/sh
# Render / production: set UAM_BACKEND_UPSTREAM and DEMO_BACKEND_UPSTREAM in the
# dashboard (not in git). Local Docker Compose defaults match dev stack service names.
set -e

UAM="${UAM_BACKEND_UPSTREAM:-uam-backend:8080}"
DEMO="${DEMO_BACKEND_UPSTREAM:-backend-test-service:8080}"

TEMPLATE="/app/conf.d/initial-snapshot.template.json"
OUTPUT="/app/conf.d/initial-snapshot.json"

if [ ! -f "$TEMPLATE" ]; then
  echo "control-plane: missing $TEMPLATE" >&2
  exit 1
fi

sed -e "s|__UAM_BACKEND_UPSTREAM__|${UAM}|g" \
    -e "s|__DEMO_BACKEND_UPSTREAM__|${DEMO}|g" \
    "$TEMPLATE" > "$OUTPUT"

echo "control-plane: wrote $OUTPUT (uam=$UAM demo=$DEMO)"
exec control-plane "$@"
