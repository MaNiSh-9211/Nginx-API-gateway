# Docker Commands — Full Stack & Per Service

All compose files live in `dev/`. Secrets resolve from `dev/.env` (gitignored).

The **application stack** (7 services) uses two compose files:

```
docker-compose.yml + docker-compose.uam.yml
```

Services: `gateway-edge`, `control-plane`, `config-sidecar`, `uam-backend`,
`uam-frontend`, `demo-backend`, `demo-frontend`.

External dependencies are **cloud** services (Upstash Redis, Aiven Postgres,
Grafana Cloud OTLP) — no local redis/prometheus containers needed.

---

## 0. The compose prefix

Every command below uses this file list. Set it once per shell:

**Windows PowerShell**
```powershell
$CF = @("-f","docker-compose.yml","-f","docker-compose.uam.yml")
cd dev
```

**macOS / Linux (bash/zsh)**
```bash
cd dev
CF=(-f docker-compose.yml -f docker-compose.uam.yml)
# use as: docker compose "${CF[@]}" ...
```

---

## 1. Full stack — up / down / status

| Action | Windows PowerShell | macOS / Linux |
|---|---|---|
| Build + start all | `docker compose $CF up -d --build` | `docker compose "${CF[@]}" up -d --build` |
| Start (no rebuild) | `docker compose $CF up -d` | `docker compose "${CF[@]}" up -d` |
| Status | `docker compose $CF ps` | `docker compose "${CF[@]}" ps` |
| Stop (keep containers) | `docker compose $CF stop` | `docker compose "${CF[@]}" stop` |
| Down (remove) | `docker compose $CF down` | `docker compose "${CF[@]}" down` |
| Down + orphans | `docker compose $CF down --remove-orphans` | `docker compose "${CF[@]}" down --remove-orphans` |

Root helpers: `./start.sh` / `./stop.sh` (bash; full stack incl. testing overlay).

---

## 2. Per-service commands

Replace `<svc>` with one of:
`gateway-edge` · `control-plane` · `config-sidecar` · `uam-backend` ·
`uam-frontend` · `demo-backend` · `demo-frontend`

| Action | Windows PowerShell | macOS / Linux |
|---|---|---|
| Rebuild + restart one | `docker compose $CF up -d --build <svc>` | `docker compose "${CF[@]}" up -d --build <svc>` |
| Restart only | `docker compose $CF restart <svc>` | `docker compose "${CF[@]}" restart <svc>` |
| Logs (follow) | `docker compose $CF logs -f <svc>` | `docker compose "${CF[@]}" logs -f <svc>` |
| Last 50 lines | `docker compose $CF logs --tail 50 <svc>` | `docker compose "${CF[@]}" logs --tail 50 <svc>` |
| Shell into container | `docker exec -it dev-<svc>-1 sh` | same |

### Common one-liners

**Windows PowerShell**
```powershell
# gateway-edge
docker compose $CF up -d --build gateway-edge ; docker compose $CF logs -f gateway-edge

# uam-backend
docker compose $CF up -d --build uam-backend ; docker compose $CF logs -f uam-backend

# control-plane
docker compose $CF up -d --build control-plane ; docker compose $CF logs -f control-plane
```

**macOS / Linux**
```bash
docker compose "${CF[@]}" up -d --build gateway-edge && docker compose "${CF[@]}" logs -f gateway-edge
docker compose "${CF[@]}" up -d --build uam-backend && docker compose "${CF[@]}" logs -f uam-backend
docker compose "${CF[@]}" up -d --build control-plane && docker compose "${CF[@]}" logs -f control-plane
```

---

## 3. URLs after boot

| Service | URL |
|---|---|
| UAM frontend | http://localhost:8091 |
| Demo frontend | http://localhost:8088 |
| Gateway (edge) | http://localhost:18083/health |
| Control plane | http://127.0.0.1:18081/health |
| uam-backend (direct, loopback) | http://127.0.0.1:18080/health |

---

## 4. Health & connectivity probes

```powershell
# edge ready + config version
curl http://localhost:18083/health ; curl http://localhost:18083/ready

# control-plane: postgres ok? redis circuit closed?
curl http://127.0.0.1:18081/health

# uam-backend: redis connected? distributed limiting?
curl http://127.0.0.1:18080/health
```

Edge → Redis live proof (snapshot syncs tick every 5 s):
```powershell
docker exec dev-gateway-edge-1 curl -s http://127.0.0.1:8080/metrics | Select-String auth_snapshot
```

---

## 5. Observability

All three services export OTLP (traces/metrics/logs) to **Grafana Cloud**.
Verify no export errors:

```powershell
docker compose $CF logs --since 5m gateway-edge | Select-String "\[otlp\]"
docker compose $CF logs --since 5m uam-backend | Select-String "export failed"
```

(empty output = clean). View data in Grafana Cloud Explore:
Tempo (`service_name` selector), Mimir metrics (`gateway_*`, `uam_*`,
`controlplane_*`), Loki logs (`{service_name="gateway-edge"}` etc.).

---

## 6. Optional extras (not part of the app stack)

Local Redis + Prometheus for offline work:
```powershell
docker compose -f docker-compose.yml -f docker-compose.uam.yml -f docker-compose.local.yml up -d redis prometheus
```
Test-only echo/backend/frontend services: add `-f docker-compose.testing.yml`.
