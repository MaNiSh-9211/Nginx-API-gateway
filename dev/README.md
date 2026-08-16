# Local development orchestration

This folder wires **independent sibling repos** together for local testing. It is **not deployed** to production.

Each service is built from its own folder:

| Repo folder | Image | Deploy? |
|-------------|-------|---------|
| `../gateway-edge` | `api-gateway` | Yes |
| `../gateway-sidecar` | `config-sidecar` | Yes |
| `../gateway-control-plane` | `control-plane` | Yes |
| `../gateway-redis` | `gateway-redis` | Optional |
| `../uam-backend` | `uam-backend` | Yes |
| `../uam-frontend` | `uam-frontend` | Yes |
| `../demo-backend` | `backend-test-service` | **No** (dev only) |
| `../demo-frontend` | `frontend-test-service` | **No** (dev only) |

---

## Prerequisites

- Docker Desktop or Docker Engine + Compose v2
- PowerShell 5+ (Windows E2E) or Bash (e2e.sh)

---

## Setup

```bash
cd dev
# Safe defaults already committed in .env files
cp .env.example .env.dev          # then add real credentials (MongoDB Atlas, OAuth)
../scripts/setup-dev-env.ps1      # or bootstrap all services at once (Windows)
```

**Public repo rule:** only `.env` and `.env.example` are committed. Real secrets go in **`.env.dev`** (gitignored).

---

## Environment files (every service + `dev/`)

| File | Committed? | Purpose |
|------|------------|---------|
| `.env.example` | Yes | Template — all keys documented with placeholders |
| `.env` | Yes | Safe dev defaults so `docker compose up` works out of the box |
| `.env.dev` | **No** | Your real credentials (Atlas URI, OAuth, SMTP, rotated JWTs) |

Compose load order (later wins): `dev/.env` → `dev/.env.dev` → `<service>/.env` → `<service>/.env.dev`

Folders with the three-file layout:

`dev/`, `gateway-edge/`, `gateway-control-plane/`, `gateway-sidecar/`, `gateway-redis/`, `uam-backend/`, `uam-frontend/`, `demo-backend/`, `demo-frontend/`

**MongoDB:** set `MONGODB_URI` in `dev/.env.dev` for Atlas (database name `uam`). Or use local mongo: `docker compose --profile local-mongo …`

---

## Compose files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Base stack: gateway, sidecar, control plane, Redis, Prometheus, Grafana |
| `docker-compose.testing.yml` | Adds demo-backend + demo-frontend test console |
| `docker-compose.uam.yml` | Adds MongoDB, uam-backend, uam-frontend |
| `docker-compose.multi-region.yml` | Standalone EU/US/AP PoP simulation (separate from base stack) |

### Gateway only

```bash
docker compose -f docker-compose.yml up --build
```

### Full dev stack (recommended)

Gateway + demo console + UAM + monitoring:

```bash
# From repo root (Git Bash / WSL / Linux / macOS):
./start.sh

# Or manually:
cd dev
docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml up --build
```

Each service folder also has `start.sh` to bring up that container (and compose dependencies).

Stop everything: `./stop.sh` from repo root.

### Multi-region PoP simulation

```bash
docker compose -f docker-compose.multi-region.yml up --build
```

Uses `../platform/monitoring/prometheus/prometheus.multi-region.yml` (scrapes `gateway-eu`, `gateway-us`, `gateway-ap`). Do **not** run multi-region and single-node stacks on the same host ports simultaneously.

---

## URLs (default ports)

| URL | Service |
|-----|---------|
| http://localhost:18083 | Gateway |
| http://localhost:18085 | Control plane (127.0.0.1 bind in base stack) |
| http://localhost:8090 | Demo test console (testing overlay) |
| http://localhost:8091 | UAM login console (UAM overlay) |
| http://localhost:9090 | Prometheus (all scrape targets) |
| http://localhost:3000 | Grafana (dashboards auto-provisioned) |

Multi-region host ports: EU `18083`, US `18084`, AP `18086` (see `docker-compose.multi-region.yml`).

---

## Tests

Stack must be **running** before E2E tests.

```powershell
cd dev
powershell -File test.ps1                  # Gateway E2E — 39 checks
powershell -File scripts/test-uam.ps1      # UAM integration — 22 checks (needs UAM overlay)
powershell -File scripts/test-all.ps1      # Both suites
```

```bash
# CI smoke (bash, from repo root)
chmod +x dev/tests/e2e.sh && dev/tests/e2e.sh
```

```powershell
# Pre-release gate (unit tests + compose validate + helm lint + E2E)
powershell -File scripts/release-check.ps1
powershell -File scripts/release-check.ps1 -SkipE2E   # skip live stack tests
```

Rust unit tests:

```bash
cd ../gateway-edge/rust-ext && cargo test --release
cd ../gateway-control-plane && cargo test --release
cd ../gateway-sidecar && cargo test --release
```

Makefile shortcuts (run from `dev/`): `make test`, `make test-unit`, `make validate`, `make release-check`.

---

## Monitoring (Prometheus + Grafana)

Included in the base stack. With the UAM overlay, Prometheus switches to `prometheus.full.yml` and scrapes all production services (excluding demo-backend/demo-frontend).

| Job | Service | Metrics |
|-----|---------|---------|
| `gateway` | gateway-edge | Hot-path counters, latency histogram, WAF, circuit breaker |
| `control-plane` | gateway-control-plane | Config version, service/route counts |
| `config-sidecar` | gateway-sidecar | Poll/update/error counters (`:9092`) |
| `redis` | redis-exporter | Memory, connections, commands |
| `uam-backend` | uam-backend (UAM overlay) | HTTP request rate, latency, process stats |
| `mongodb` | mongodb-exporter (UAM overlay) | Connections, opcounters |
| `uam-frontend-nginx` | nginx-exporter (UAM overlay) | nginx stub_status |

**Grafana dashboards** (auto-provisioned at http://localhost:3000):

- API Gateway — Hot Path
- Platform — Stack Overview
- UAM — Auth Service

Alert rules: `platform/monitoring/prometheus/rules/` (`gateway-alerts`, `infra-alerts`, `uam-alerts`).

---

## Environment variables

See **Environment files** above. Production uses Helm / K8s Secrets — never `.env.dev` files.

| Shared in `dev/.env` / `dev/.env.dev` | Used by |
|---------------------------------------|---------|
| `JWT_SECRET` | gateway-edge, control-plane, uam-backend, demo-backend |
| `MONGODB_URI` | uam-backend (put Atlas URI in `.env.dev`) |
| `ADMIN_API_KEY` | control-plane, uam-backend |
| `PASSWORD_PEPPER` | uam-backend, demo-backend |
| `UAM_FRONTEND_PORT` | uam-frontend URL, OAuth callbacks |
| `FRONTEND_TEST_PORT` | demo-frontend host port |

---

## Production

Build and push each `../<repo>/` image separately. Deploy with Helm: [`../platform/deploy/helm/`](../platform/deploy/helm/api-gateway/README.md).

Do **not** deploy `dev/`, `demo-backend/`, or `demo-frontend/`.
