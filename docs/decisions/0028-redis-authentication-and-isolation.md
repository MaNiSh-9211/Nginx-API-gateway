# ADR-0028 — Redis authentication and network isolation

**Status:** Accepted

## Context

Redis backs the JWT **revocation list** (ADR-0022) and is available for
coordination. Redis has no transport encryption by default and, historically,
unauthenticated Redis exposed to a network is a classic breach vector
(RCE via `CONFIG SET dir` + `SAVE`, data exfiltration, cache poisoning).

In this project Redis is reached only by the gateway (revocation lookups). We
need a default that is safe in the reference stack and a clear path to harden
for shared or managed Redis.

## Decision

**Defense in depth, layered by environment.**

1. **Network isolation is the primary control.** In `docker-compose.yml`, Redis
   has **no published host port** (internal Docker network only); `protected-mode`
   is off solely because the bind is already private. In Kubernetes, Redis is a
   ClusterIP service with NetworkPolicies recommended.
2. **Optional password auth.** The gateway builds its Redis URL via `redis_url()`:
   - `REDIS_PASSWORD` unset → `redis://host:port`
   - `REDIS_PASSWORD` set → `redis://:<password>@host:port`
   Set `requirepass` in `redis/redis.conf` and export the same `REDIS_PASSWORD`
   to the gateway (and Helm `redis.password`). They must match.
3. **Dangerous-command hygiene.** `redis.conf` documents `rename-command` for
   `FLUSHALL`/`FLUSHDB`/`CONFIG` in shared environments.

## Alternatives considered

- **Always require a password, even in dev.** More friction for the reference
  stack with no real security gain when the port is unpublished; we make it
  opt-in but first-class.
- **TLS to Redis (`rediss://`).** Enabled via `REDIS_TLS=1`; uses native TLS
  in the Redis client (`tls-native-tls`). Required for ElastiCache / Azure
  encryption when Redis leaves the strictest private network boundary.
- **ACL users (Redis 6+).** Finer-grained than `requirepass`; a good next step
  for least-privilege (a gateway user that can only `GET gateway:revoked:*`).
- **Drop Redis entirely.** Loses revocation; rejected (ADR-0022).

## Consequences

- The reference stack stays zero-config while production can enable auth with one
  env var on each side.
- Password in env/ConfigMap is base64-only at rest in K8s — use a Secret or an
  external secrets operator for real deployments (mirror ADR-0013).
- If `REDIS_PASSWORD` and `requirepass` drift, revocation lookups fail; with
  fail-open (ADR-0022) that silently disables revocation — monitor `redis_up`.

## Related

- [ADR-0022 — Redis revocation fail-open](0022-redis-revocation-fail-open.md)
- [ADR-0013 — Secrets via environment](0013-secrets-via-environment-not-config-wire.md)
- [docs/SECURITY.md](../SECURITY.md)
