# ADR-0005 — Local HS256 JWT validation with LRU cache + revocation

**Status:** Accepted

## Context

Auth is on every authenticated request. The options trade latency, security, and
operational coupling. We need: low per-request cost, resistance to common JWT
attacks, support for key rotation, and a way to revoke tokens early.

## Decision

Validate **HS256 JWTs locally in Rust**, with:

- **Strict `alg` check** — only `HS256` accepted. Rejects the `alg:none` attack
  and RS256→HS256 key-confusion.
- **Full claim checks** — required `exp`; `nbf`; `iat` max-age (24 h); strict
  `iss`/`aud` (configurable, ADR default `api-gateway-auth-server` /
  `api-gateway-clients`).
- **`kid`-based key rotation** — tokens may name a key in `jwt_keys` for
  zero-downtime secret rotation. Because `jwt_keys` is secret material, it is
  sourced from the gateway's own environment (`JWT_KEYS`, a JSON object of
  `kid`→secret) and **never** travels on the config wire — the control plane
  strips it from `GET /config` (ADR-0013). A token with an unknown `kid` is
  rejected. *(Note: this env path is mandatory — without it the gateway would
  receive an empty key map and reject every `kid`-bearing token.)*
- **Constant-time signature compare** — no timing side channel.
- **Thread-local LRU cache (8,192 entries)** — repeat tokens validate in ~50 ns
  (ADR-0003); eviction is gradual (no thundering herd).
- **Best-effort Redis revocation** on cache miss — a revoked token is rejected
  even before `exp`. If Redis is down, the signature is still fully verified, so
  we fail *open only on revocation*, never on authenticity.
- **CRLF/NUL sanitization** of identity values forwarded upstream (prevents
  header injection / request smuggling).

## Alternatives considered

- **Opaque tokens + introspection (OAuth2 introspection).** Strong central
  control, but a network round trip per request to the auth server — far over
  budget and a new hard dependency. Rejected for the hot path.
- **RS256/ES256 (asymmetric).** Better for multi-party trust (gateway only needs
  a public key). Defensible and may be added; HS256 chosen first for raw speed
  and simplicity given the gateway and issuer are operated together. The strict
  `alg` check exists precisely to keep an HS256 verifier from being tricked by an
  RS256-signed token.
- **No revocation (rely on short TTLs only).** Simpler, but cannot kill a leaked
  token before expiry. We add best-effort revocation without paying for it on
  cache hits.
- **Shared (cross-worker) token cache.** More hits, but adds coordination;
  per-worker thread-local is contention-free and tokens are cheap to re-validate
  once per worker (ADR-0003).

## Consequences

- ~50 ns cached / ~2–5 µs cold; no per-request network dependency for authn.
- Rotation and early revocation are supported.
- Cost: secret distribution must be solved out-of-band (ADR-0013); revocation is
  best-effort under Redis failure (a deliberate availability-over-strictness
  choice for that one check).
