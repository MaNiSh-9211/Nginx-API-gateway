# gateway-sidecar

**Deployable repo:** Config fetcher — one container **per gateway node**.

Pulls routing snapshot from control-plane and writes `/etc/gateway/config.json` for the edge to watch.

## Build

```bash
docker build -t config-sidecar:latest .
```

## Run

```bash
docker run --rm \
  -e CONTROL_PLANE_URL=http://control-plane:8081 \
  -e GATEWAY_CONFIG_PATH=/etc/gateway/config.json \
  -v gateway-config:/etc/gateway \
  config-sidecar:latest
```

## Production

## Production

Sidecar container in the **same pod** as `gateway-edge` (shared volume). Exposes Prometheus metrics on `METRICS_PORT` (default `9092`).

Local full stack: [`../dev/README.md`](../dev/README.md)
