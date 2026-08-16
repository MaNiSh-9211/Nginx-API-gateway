# ADR-0023 — Control plane admin API: HMAC request signing

**Status:** Accepted

## Context

The control plane exposes `GET /config` to every gateway node (high read volume,
must be lock-free). It also exposes **mutations**: `POST /config` and
`POST /config/rollback`. Anyone who can reach port 8081 could push malicious
routing, disable auth, or point traffic at attacker-controlled upstreams.

We need authentication that:

- Works for automation (CI/CD, GitOps pipelines) without browser cookies
- Does not add latency to the hot `GET /config` path
- Survives config pushes with large JSON bodies

## Decision

**HMAC-SHA256 over the raw request body**, keyed by `ADMIN_API_KEY` (env only,
never in config JSON).

| Endpoint | Auth |
|----------|------|
| `GET /config` | None (read-only, secrets stripped) |
| `GET /config/history` | None (version strings only) |
| `POST /config` | `X-Admin-Signature: sha256=<hex>` + `X-Admin-Timestamp` + `X-Admin-Nonce` |
| `POST /config/rollback` | Same headers; sign empty body `b""` |

Signed material (production): `"{timestamp}\n{nonce}\n" || body_bytes`. Nonces are
stored in Redis (`SET NX`, 10 min TTL) to block replay of captured requests.
Timestamp must be within ±5 minutes of server clock.

Additional controls:

- **Constant-time** hex comparison (prevents timing attacks on the digest)
- **30 mutations/minute/IP** rate limit on POST endpoints (blocks brute-force
  signature guessing). Keyed on the **real TCP peer address** (`peer_addr`), not
  `X-Forwarded-For`/`Forwarded`: those headers are client-supplied and would let
  an attacker both bypass the limit and flood the bucket map (memory DoS). Behind
  a trusted proxy, terminate XFF there and restrict the admin port by network
  policy. The bucket map prunes elapsed windows so it stays bounded.
- **Dev bypass**: if `ADMIN_API_KEY` is still the placeholder
  `change_me_in_production`, verification is skipped with a log warning

## Alternatives considered

- **Bearer token in `Authorization` header.** Simpler for humans, but tokens
  leak in logs more easily than a signature over the body; replay of a captured
  token can re-push the same config. HMAC binds the signature to the exact bytes
  being applied.
- **mTLS between operators and control plane.** Strongest network boundary;
  recommended in production *in addition* to HMAC. Not sufficient alone for
  compromised client certs.
- **OAuth2 / OIDC for admin UI.** Right for a future GUI; overkill for GitOps
  pipelines pushing JSON from CI.

## Consequences

- Operators must sign config pushes (see `docs/OPERATIONS.md`).
- `ADMIN_API_KEY` rotation requires updating CI secrets and sidecars unaffected
  (they only read).
- Default dev key allows unsigned pushes — **must** be changed before any
  production exposure.

## Related

- [ADR-0011 — Control plane GitOps](0011-control-plane-gitops.md)
- [ADR-0013 — Secrets via environment](0013-secrets-via-environment-not-config-wire.md)
