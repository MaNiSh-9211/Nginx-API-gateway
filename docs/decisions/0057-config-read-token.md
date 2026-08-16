# ADR-0057: Config read token for control-plane GET endpoints

## Status

Accepted

## Context

Gateway nodes poll `GET /config` every few seconds via the config sidecar. The
response intentionally omits `jwt_secret` and `jwt_keys` ([ADR-0013](0013-secrets-not-in-config-wire.md)),
but still exposes routing topology, rate limits, and JWT `iss`/`aud` expectations.

When the control-plane admin port is reachable from a broader network (e.g.
host-mapped in Docker Compose, misconfigured K8s Service), an attacker could
enumerate services and craft targeted attacks.

## Decision

1. Introduce optional env `CONFIG_READ_TOKEN` on the control plane.
2. When set (non-empty), `GET /config` and `GET /config/history` require header
   `X-Config-Read-Token` with an exact match; otherwise return `401`.
3. The config sidecar sends this header on every poll when the env is set.
4. Unset `CONFIG_READ_TOKEN` = backward-compatible open reads (base Compose dev).
5. UAM overlay (`docker-compose.uam.yml`) sets a dev default and enables
   `REVOCATION_FAIL_CLOSED=1` on the gateway.
6. Helm chart stores `CONFIG_READ_TOKEN` in `gateway-secrets` and injects it
   into control-plane and config-sidecar.

## Consequences

- Operators must rotate `CONFIG_READ_TOKEN` with other control-plane secrets.
- External config consumers (custom sidecars) must send the header in production.
- `POST /config`, `POST /revoke`, and admin mutations remain protected by
  `X-Admin-Signature` ([ADR-0023](0023-admin-hmac-replay-protection.md)).
- `/health` and `/metrics` stay unauthenticated for probes and Prometheus.
