# ADR-0045 — Helm production-safe defaults

**Status:** Accepted

## Context

Helm charts encode **opinionated production defaults**. Operators can override
`values.yaml`, but unsafe defaults (dev secrets accepted, revoke API without
Redis, single refuse flag on gateway only) cause silent production misconfigs.

## Decision

Default `values.yaml` and templates enforce:

| Default | Value | Why |
|---------|-------|-----|
| `refuseInsecureSecrets` | `true` | Sets `GATEWAY_REFUSE_INSECURE_SECRETS` **and** `CONTROL_PLANE_REFUSE_INSECURE_SECRETS` — [ADR-0041](0041-refuse-insecure-secrets-at-startup.md) |
| `gateway.replicas` | `2` | Rolling deploy + HA — [ADR-0031](0031-graceful-shutdown-zero-downtime.md) |
| `terminationGracePeriodSeconds` | `45` | Drain in-flight before SIGKILL — [ADR-0031](0031-graceful-shutdown-zero-downtime.md) |
| `secrets.create` + required values | placeholders | Forces explicit `--set secrets.*` at install — [ADR-0013](0013-secrets-via-environment-not-config-wire.md) |
| Control plane `REDIS_*` env | from `values.redis` | `POST /revoke` must reach Redis — [ADR-0039](0039-control-plane-revoke-api.md) |
| `revocationFailClosed` | `false` | Fail-open default; opt-in for high-assurance — [ADR-0022](0022-redis-revocation-fail-open.md) |

**Not** defaulted (operator must choose):

- `networkPolicy` — CNI-specific ([ADR-0044](0044-kubernetes-network-segmentation.md))
- `gateway.tls.enabled` — cert provisioning varies per cluster
- `gateway.region` — must match PoP (`EU`/`US`/`AP`)

## Alternatives considered

- **Dev-friendly Helm defaults (`refuseInsecureSecrets: false`).** Easier local
  `helm install` but ships insecure-by-default; rejected for a production chart.
- **Bundled Redis subchart.** Convenient for demos; production uses managed Redis —
  `redis.host` points at external service.
- **Auto-generate secrets in chart.** Secrets in Helm release state are hard to
  rotate; explicit `kubectl create secret` or External Secrets preferred.

## Consequences

- `helm install` with placeholder `secrets.*` still fails refuse check until
  real secrets are supplied — intentional.
- Control plane revoke works out of the box when Redis is reachable at `redis.host`.
- Dev clusters override `refuseInsecureSecrets: false` if using `.env` dev keys.

## Related

- [platform/deploy/helm/api-gateway/values.yaml](../../platform/deploy/helm/api-gateway/values.yaml)
- [ADR-0041](0041-refuse-insecure-secrets-at-startup.md)
- [ADR-0039](0039-control-plane-revoke-api.md)
