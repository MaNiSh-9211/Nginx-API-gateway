# Helm chart — API Gateway

Production Kubernetes deployment using the **sidecar pattern** (ADR-0012).

## Prerequisites

- Kubernetes 1.24+
- Helm 3
- Container images pushed to your registry
- Redis reachable at `redis.host` (deploy separately or use a managed service)

## Install

```bash
# 1. Set secrets (never use defaults in production)
helm upgrade --install api-gateway ./platform/deploy/helm/api-gateway \
  --namespace api-gateway --create-namespace \
  --set secrets.jwtSecret="$(openssl rand -hex 32)" \
  --set secrets.adminApiKey="$(openssl rand -hex 32)" \
  --set images.gateway.repository=your-registry/api-gateway \
  --set images.configSidecar.repository=your-registry/config-sidecar \
  --set images.controlPlane.repository=your-registry/control-plane \
  --set gateway.region=EU

# 2. Verify
kubectl -n api-gateway get pods
kubectl -n api-gateway port-forward svc/gateway 8080:80
curl -s localhost:8080/ready
```

## Key values

| Value | Default | ADR |
|-------|---------|-----|
| `gateway.region` | `GLOBAL` | [0014](../../docs/decisions/0014-data-residency-identity-routing.md) |
| `revocationFailClosed` | `false` | [0022](../../docs/decisions/0022-redis-revocation-fail-open.md) |
| `refuseInsecureSecrets` | `true` | [0041](../../docs/decisions/0041-refuse-insecure-secrets-at-startup.md) — gateway + control plane |
| `gateway.tls.enabled` | `false` | [0016](../../docs/decisions/0016-tls-termination.md) |
| `secrets.*` | placeholders | [0013](../../docs/decisions/0013-secrets-via-environment-not-config-wire.md) |

## Probes

- Gateway **liveness**: `/health` (ADR-0024)
- Gateway **readiness**: `/ready` (config loaded)
- Sidecar **liveness**: config file exists

## Admin APIs (private network only)

- `POST /config` — signed config push ([ADR-0023](../../docs/decisions/0023-admin-api-hmac-authentication.md))
- `POST /config/rollback` — revert version
- `POST /revoke` — publish JWT revocation to Redis ([ADR-0039](../../docs/decisions/0039-control-plane-revoke-api.md))

## Related

- Raw manifests: [`../kubernetes/`](../kubernetes/)
- Operations: [`../../docs/OPERATIONS.md`](../../docs/OPERATIONS.md)
- Production checklist: [`../../docs/PRODUCTION.md`](../../docs/PRODUCTION.md)
