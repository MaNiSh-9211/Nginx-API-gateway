# gateway-edge

**Deployable repo:** OpenResty data plane + Rust FFI (WAF, JWT, routing, rate limits).

One container image: `api-gateway`.

**Includes bundled `config-sidecar`** — polls control-plane and writes `/etc/gateway/config.json` before OpenResty starts. On Render you deploy **this repo only** (no separate sidecar service).

## Build

```bash
docker build -t api-gateway:latest .
```

## Run (standalone smoke)

```bash
docker run --rm -p 8080:8080 \
  -e REDIS_HOST=redis \
  -e CONTROL_PLANE_URL=http://control-plane:8081 \
  -e CONFIG_READ_TOKEN=your-token \
  -e GATEWAY_REGION=GLOBAL \
  api-gateway:latest
```

## Render (single Web Service)

| Setting | Value |
|---------|--------|
| Repo | this repository |
| Runtime | Docker |
| Region | Singapore (same as Redis + backends) |
| Health check | `/ready` |

Set env vars in the Render dashboard (see `.env.example`). **Do not deploy `gateway-sidecar` separately** — it runs inside this container.

**Render gotchas:**
- `CONFIG_READ_TOKEN` must **exactly match** `gateway-control-plane` (otherwise sidecar gets 401 on `/config`).
- Set service **Port to `8080`** (or `METRICS_PORT=0`) so Render does not auto-detect sidecar metrics on `9092`.

HTTPS upstreams (`host:443` from control-plane) are supported for Render backends (`*.onrender.com`).

## Production (Kubernetes)

Helm can still run sidecar as a separate container in the same pod, or use this bundled image.

Helm: `../platform/deploy/helm/api-gateway/`

## Local full stack

See `../dev/README.md` — compose may still run sidecar as a separate container with a shared volume.
