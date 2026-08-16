# Production Deployment Checklist

Use this checklist when moving from the local Docker reference stack to a real
fleet. Every item links to the Architecture Decision Record that explains *why*.

## Before you deploy

- [ ] **Read the ADRs** — [`docs/decisions/README.md`](decisions/README.md) documents
      every major trade-off (stack, FFI, lock-free design, config model, etc.).
- [ ] **Replace all placeholder secrets** (ADR-0013):
  - `JWT_SECRET` — must match your auth server's signing key
  - `ADMIN_API_KEY` — non-default value enables HMAC on `POST /config`
  - `GRAFANA_ADMIN_PASSWORD`
- [ ] **Mount real TLS certificates** at `/etc/nginx/certs/server.{crt,key}`
      (ADR-0016). Do not bake private keys into images.
- [ ] **Set `GATEWAY_REGION`** per PoP: `EU`, `US`, `AP`, or `GLOBAL` for
      single-region dev (ADR-0014).
- [ ] **Apply kernel / ulimit tuning** from `platform/monitoring/sysctl/` and
      `platform/monitoring/limits/` on each host (ADR-0019).

## Topology (per node)

```
┌─────────────────────────────────────────┐
│  Node                                   │
│  ┌─────────────┐   ┌─────────────────┐   │
│  │ config-     │──▶│ gateway         │   │
│  │ sidecar (1) │   │ OpenResty+Rust  │   │
│  └──────┬──────┘   └────────┬────────┘   │
│         │ HTTP              │ proxy      │
│         ▼                   ▼            │
│  shared config volume    upstreams       │
└─────────────────────────────────────────┘
         │
         ▼
   control-plane (regional or global)
```

- **One `config-sidecar` per gateway pod/VM** (ADR-0012).
- **One shared volume** (or host path) for `GATEWAY_CONFIG_PATH`.
- Gateway **readiness** = `GET /ready` returns 200 when config is loaded
  (`gateway_config_ready 1` in `/metrics`).

## Kubernetes sketch

See [`platform/deploy/kubernetes/`](../platform/deploy/kubernetes/) or the Helm chart at
[`platform/deploy/helm/api-gateway/`](../platform/deploy/helm/api-gateway/).

```yaml
# Per gateway pod:
# - container: gateway (OpenResty image)
# - container: config-sidecar (shares emptyDir at /etc/gateway)
# - env: JWT_SECRET from Secret
# - env: GATEWAY_REGION=EU
# - livenessProbe:  GET /health
# - readinessProbe: GET /ready
```

## Observability

- Scrape `gateway:8080/metrics` and `control-plane:8081/metrics` (ADR-0015).
- Import alert rules from `platform/monitoring/prometheus/rules/gateway-alerts.yml`.
- Grafana dashboard **API Gateway — Hot Path** is auto-provisioned from
  `platform/monitoring/grafana/provisioning/dashboards/json/`.
- SLO targets: [SLO.md](SLO.md) (availability, latency, capacity).

## Network segmentation (Kubernetes)

Apply adapted NetworkPolicies from `platform/deploy/kubernetes/network-policy.yaml`
(ADR-0044). Control plane and Redis must not be reachable from arbitrary pods.

## Config changes (GitOps)

1. Commit JSON to `gateway-control-plane/conf.d/` (or your config repo).
2. `POST /config` with `X-Admin-Signature: sha256=<hmac(body, ADMIN_API_KEY)>`.
3. Sidecars pick up the new version within ~5 s; gateways hot-swap via ArcSwap.
4. Roll back with `POST /config/rollback` (signed).

## Security hardening

| Control | Where |
|---------|--------|
| WAF (injection, bots, per-IP limit) | Rust hot path (ADR-0006) |
| JWT strict validation + revocation | Rust (ADR-0005, ADR-0038) |
| Token logout / compromise | `POST /revoke` (ADR-0039) |
| Signed config mutations | Control plane (ADR-0011) |
| Secrets not on config wire | Env / vault (ADR-0013) |
| Refuse dev JWT_SECRET in prod | `GATEWAY_REFUSE_INSECURE_SECRETS` (ADR-0041) |
| Identity to upstreams | `X-User-Id`, `X-Home-Region` (ADR-0040) |
| `/metrics` internal only | `gateway-locations.conf` |
| Security headers + TLS 1.2/1.3 | `nginx.conf` (ADR-0016) |

## Load & chaos validation

```powershell
cd dev
powershell -File test.ps1
powershell -File scripts/load-test.ps1 -Smoke   # ~30 s, 50 VUs
powershell -File scripts/load-test.ps1          # full, 500 VUs
powershell -File tests/chaos_test.ps1
```
```

See [PERFORMANCE.md](PERFORMANCE.md) for latency budget and benchmark results.

## Common pitfalls (fixed in this repo)

| Symptom | Cause | Fix |
|---------|-------|-----|
| 502 from gateway | LB returned upstream `name` not `host:port` | Use `address` for `proxy_pass` |
| All JWTs rejected | `JWT_SECRET` mismatch or missing `iss`/`aud` | Align env + token claims |
| 403 for valid region | `GATEWAY_REGION` ≠ token `home_region` | Use `GLOBAL` or match codes |
| `/ready` 503 forever | Sidecar not writing config file | Check sidecar logs + volume |
| Config never loads | `jwt_secret` required in JSON | Gateway injects from env (fixed) |

## Multi-region

- Run one PoP per region with matching `GATEWAY_REGION`.
- Front with GeoDNS / anycast (templates in `platform/monitoring/anycast/`).
- See ADR-0018 and `dev/docker-compose.multi-region.yml`.
