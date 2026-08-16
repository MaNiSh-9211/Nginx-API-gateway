#!/usr/bin/env bash
# Shared Docker Compose helpers for per-service and full-stack start scripts.
_COMPOSE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export REPO_ROOT="$(cd "$_COMPOSE_LIB_DIR/.." && pwd)"
export DEV_DIR="$REPO_ROOT/dev"

COMPOSE_BASE=(
    -f "$DEV_DIR/docker-compose.yml"
)
COMPOSE_TESTING=(
    -f "$DEV_DIR/docker-compose.yml"
    -f "$DEV_DIR/docker-compose.testing.yml"
)
COMPOSE_UAM=(
    -f "$DEV_DIR/docker-compose.yml"
    -f "$DEV_DIR/docker-compose.uam.yml"
)
COMPOSE_FULL=(
    -f "$DEV_DIR/docker-compose.yml"
    -f "$DEV_DIR/docker-compose.testing.yml"
    -f "$DEV_DIR/docker-compose.uam.yml"
)

ensure_dev_env() {
    if [[ ! -f "$DEV_DIR/.env" ]]; then
        if [[ -f "$DEV_DIR/.env.example" ]]; then
            cp "$DEV_DIR/.env.example" "$DEV_DIR/.env"
            echo "Created dev/.env from dev/.env.example"
        else
            echo "Warning: dev/.env missing." >&2
        fi
    fi
    if [[ ! -f "$DEV_DIR/.env.dev" ]]; then
        echo "Warning: dev/.env.dev missing — copy dev/.env.example to dev/.env.dev and add real credentials (MongoDB Atlas, OAuth)." >&2
    fi
}

load_dev_env() {
    ensure_dev_env
    set -a
    if [[ -f "$DEV_DIR/.env" ]]; then
        # shellcheck disable=SC1091
        source "$DEV_DIR/.env"
    fi
    if [[ -f "$DEV_DIR/.env.dev" ]]; then
        # shellcheck disable=SC1091
        source "$DEV_DIR/.env.dev"
    fi
    set +a
}

print_stack_urls() {
    load_dev_env
    echo ""
    echo "=== URLs (default ports) ==="
    echo "  Gateway:       http://localhost:${GATEWAY_PORT:-18083}"
    echo "  Control plane: http://localhost:${CONTROL_PLANE_PORT:-18085}"
    echo "  Demo app:      http://localhost:${FRONTEND_TEST_PORT:-8090}"
    echo "  UAM app:       http://localhost:${UAM_FRONTEND_PORT:-8091}"
    echo "  Prometheus:    http://localhost:${PROMETHEUS_PORT:-9090}"
    echo "  Grafana:       http://localhost:${GRAFANA_PORT:-3000}"
    echo ""
    echo "  Logs:  cd dev && docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml logs -f"
    echo "  Stop:  ./stop.sh"
}
