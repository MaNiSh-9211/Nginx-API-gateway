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
