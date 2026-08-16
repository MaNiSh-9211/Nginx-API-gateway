# ADR-0022 — Redis revocation check: fail-open on outage

**Status:** Accepted

## Context

JWT validation is local and fast (ADR-0005), but revoked tokens must be
rejected even when their signature is still valid. A shared revocation list in
Redis lets the control plane (or auth service) publish `jti` / token keys that
gateways check on **cache miss** — after signature verification, before
accepting a new token into the LRU.

Redis can be unavailable: network partition, pod crash, maintenance window. The
gateway must choose between:

- **Fail-closed** — reject all tokens when Redis is down (high security, low
  availability).
- **Fail-open** — accept tokens that pass cryptographic checks when Redis is
  unreachable (high availability, revoked tokens may slip through briefly).

## Decision

**Fail-open for the revocation lookup only.**

Implementation (`auth::is_revoked`):

- 10 ms connection timeout to Redis.
- On connection error, timeout, or `GET` error → treat token as **not** revoked
  (`return false`).
- Signature, `exp`, `nbf`, `iss`, `aud`, and `alg` checks still run — only the
  *revocation overlay* is skipped.

Rationale: a gateway outage blocks **all** API traffic; a brief revocation gap
affects only tokens that were revoked *and* still within their `exp`. Operators
can shorten `exp` / use refresh tokens to bound exposure.

## Alternatives considered

- **Fail-closed.** Safer for high-assurance environments (financial, healthcare).
  Rejected here for the default path because a Redis blip becomes a full API
  outage; most fleets prefer degraded revocation over total downtime.
- **Local revocation replica (sync from Redis).** Better availability without
  fail-open, but adds background sync, memory, and stale-revocation windows.
  Reasonable Phase 2 if fail-open is unacceptable.
- **No revocation list.** Simpler, but logout / compromise response requires
  waiting for `exp` — unacceptable for enterprise SSO patterns.

## Consequences

- Redis outage does not take down the gateway; monitor `redis_up` and alert.
- Brief window where revoked tokens may be accepted — bound by JWT `exp` and
  LRU cache TTL (~minutes for hot tokens).
- For **fail-closed** deployments: set `REVOCATION_FAIL_CLOSED=1` (or `true`) in
  the gateway environment; tokens are rejected when Redis is unreachable.

## Related

- [ADR-0005 — Local JWT validation](0005-local-jwt-validation.md)
- [ADR-0038 — Revocation key scheme (jti + token hash)](0038-revocation-key-scheme.md)
- [docs/SECURITY.md](../SECURITY.md) — threat matrix row "Revoked token reuse"
