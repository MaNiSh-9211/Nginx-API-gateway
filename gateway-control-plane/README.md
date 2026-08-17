# gateway-control-plane

**Deployable repo:** Rust/Actix config API — routing, admin, revocation, telemetry.

Cluster-internal only in production (never public).

## Build

```bash
docker build -t control-plane:latest .
```

## Run

```bash
docker run --rm -p 8081:8081 \
  -e REDIS_HOST=redis \
  -e CONFIG_DIR=/app/conf.d \
  -v "$(pwd)/conf.d:/app/conf.d:ro" \
  control-plane:latest
```

## Config

**Docker / Render:** `docker-entrypoint.sh` builds `conf.d/initial-snapshot.json` from
`conf.d/initial-snapshot.template.json` at startup. Upstream hosts are **not** hardcoded in git.

| Env var | Purpose |
|---------|---------|
| `UAM_BACKEND_UPSTREAM` | Auth API host:port (e.g. Render uam-backend) |
| `DEMO_BACKEND_UPSTREAM` | Demo API host:port (e.g. Render demo-backend) |
| `DATABASE_URL` | Postgres for the control plane's OWN config revisions + audit (isolated `control_plane` schema; optional — blank = in-memory only) |
| `PG_SSL` | `true` → connect with `sslmode=require` (Aiven/Neon/RDS self-signed) |
| `CP_REDIS_TIMEOUT_MS` | Redis command timeout (default 1000ms, clamp 50–5000) |
| `CP_REDIS_CB_*` | Redis circuit breaker tuning (see `.env.example`) |

All Redis calls (admin-nonce de-dupe, revocation-key writes) run through a local
circuit breaker (`src/redis_cb.rs`) with bounded timeouts. `/health` reports
`redis_circuit` and `postgres`; `/metrics` exports `redis_*` dependency-health series.

## Durable config store

The control plane is a **management plane** (ADR-0011): it publishes config and
keeps a versioned history. History is persisted to Postgres in an **isolated
`control_plane` schema** (`src/store.rs`):

- `POST /config` and `POST /config/rollback` are **durable-first** — the revision
  is written to Postgres before the change is activated; if Postgres is
  configured but the write fails, the mutation is rejected (503) rather than
  silently un-audited.
- On boot, in-memory history is rebuilt from Postgres, so rollback keeps working
  across restarts. The initial `conf.d` config is seeded as the first revision.
- `GET /config/history` lists durable versions; `GET /config/audit` returns the
  full trail (action, actor IP, timestamp).
- Hot-path `GET /config` is untouched — still an `ArcSwap` read (~2 ns).

This store is the control plane's OWN operational state, NOT uam-backend's user
data (ADR-0050/0052). In production, scope it with a least-privilege Postgres role
that can only access the `control_plane` schema (see DDL in `src/store.rs`), so a
compromised control plane cannot read `public.users`.

Defaults for local Compose: `uam-backend:8080` and `backend-test-service:8080`.

**Local dev with volume mount:** mount `conf.d/` as in Run below; `initial-snapshot.json` overrides the generated file.

## Render

Add to the Render dashboard (secrets stay out of the public repo):

```env
UAM_BACKEND_UPSTREAM=uam-backend-ciqw.onrender.com:443
DEMO_BACKEND_UPSTREAM=demo-backend-01dk.onrender.com:443
```

Redeploy after changing upstream env vars.

## Production

Single deployment (or HA replicas behind load balancer). Helm: [`../platform/deploy/helm/api-gateway/`](../platform/deploy/helm/api-gateway/)

Local full stack: [`../dev/README.md`](../dev/README.md)
