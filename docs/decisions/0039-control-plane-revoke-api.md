# ADR-0039 — Control-plane revocation API

**Status:** Accepted

## Context

ADR-0038 fixed how gateways **look up** revocations in Redis (`jti` + SHA-256
token hash). Operators still need a **publisher** that writes those keys when a
user logs out, a token is compromised, or an admin forces session termination.

Alternatives:

- **Auth server writes Redis directly.** Correct for large fleets where the issuer
  already owns session state; the gateway repo cannot assume that topology.
- **Manual `redis-cli SET`.** Works in dev but is error-prone, unaudited, and
  bypasses the same HMAC/rate-limit controls we apply to config pushes.
- **No API in this repo.** Leaves a documented contract (ADR-0038) with no
  reference implementation.

## Decision

Add **`POST /revoke`** on the control plane (`services/gateway/control-plane/src/main.rs`):

- Body: `{ "jti": "...", "token": "<full-jwt>", "ttl_secs": 3600 }` — at least
  one of `jti` or `token` required.
- Writes `gateway:revoked:jti:<jti>` and/or `gateway:revoked:token:<sha256_hex>`
  via Redis `SET … EX ttl_secs`, using the **same key scheme** as the gateway.
- Protected by **`X-Admin-Signature`** (HMAC-SHA256) and the existing admin
  rate limit — same as `POST /config` ([ADR-0023](0023-admin-api-hmac-authentication.md)).
- Control plane connects to Redis only for revocation **writes**; gateways still
  do **reads** on cache miss. Separation keeps the hot path independent of
  control-plane availability.

In production, the auth server may call this API or write Redis directly; both
are valid as long as keys match ADR-0038.

## Alternatives considered

- **Webhook from gateway to auth server.** Wrong direction — revocation is a
  control action, not a data-plane concern.
- **Store revocations in config JSON.** Would require full config push + gateway
  reload for every logout; Redis TTL keys are O(1) and self-expiring.
- **Pub/Sub invalidation.** Faster propagation than polling on cache miss, but
  adds subscription state per worker; LRU already bounds exposure to one miss per
  hot token.

## Consequences

- Reference publisher for ADR-0038; E2E tests revoke via HTTP (`test.ps1` §10).
- Control plane gains a Redis dependency (write-only, not on GET /config path).
- Operators must not expose `/revoke` on the public internet — same network
  boundary as `POST /config`.

## Related

- [ADR-0038 — Revocation key scheme](0038-revocation-key-scheme.md)
- [ADR-0022 — Fail-open revocation](0022-redis-revocation-fail-open.md)
- [docs/SECURITY.md](../SECURITY.md)
- [docs/OPERATIONS.md](../OPERATIONS.md)
