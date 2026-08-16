# ADR-0038 — Revocation key scheme: `jti` first, SHA-256 token hash fallback

**Status:** Accepted (supersedes the prefix-key scheme used before v0.6.1)

## Context

ADR-0022 established a Redis-backed revocation overlay checked on JWT cache miss.
The original implementation derived the Redis key from a **prefix of the raw
token**:

```rust
let key = format!("gateway:revoked:{}", &token[..token.len().min(32)]);
```

For HS256 tokens this is unsafe. The first ~20 characters are the **constant**
base64 header `eyJhbGciOiJIUzI1NiJ9.`, followed by only a few bytes of the
base64url-encoded payload. Two consequences:

1. **Key collisions.** Unrelated tokens that share the first 32 characters map to
   the *same* revocation key. Revoking one could match others, and distinct
   tokens are not uniquely addressable — revocation is effectively coarse and
   unreliable.
2. **Token leakage.** Raw token bytes are written into Redis key names, exposing
   part of a bearer credential to anyone able to `KEYS`/`SCAN` Redis.

## Decision

Revocation is keyed by a **stable, unique, opaque identifier**, checked in one
`EXISTS` round trip over an ordered key list (`auth::revocation_keys`):

1. **`gateway:revoked:jti:<jti>`** — preferred. If the token carries a `jti`
   (RFC 7519 JWT ID) claim, revoke by ID. This lets the auth server revoke a
   logical token without ever handling the full credential.
2. **`gateway:revoked:token:<sha256_hex>`** — fallback. `sha256_hex` is the
   lowercase hex SHA-256 of the **entire** JWT. Unique per token and opaque
   (the token cannot be recovered from the key).

A revocation publisher (auth server or control plane) revokes a token by
`SET`-ting either key, ideally with a TTL equal to the token's remaining
lifetime (`exp - now`) so Redis self-cleans; the `exp` check rejects it anyway
after expiry.

The check remains **fail-open** by default (ADR-0022); `REVOCATION_FAIL_CLOSED=1`
flips it to fail-closed.

### Cache TTL bounds the revocation blind spot

Revocation is consulted only on a JWT **cache miss**. The per-worker positive
cache therefore must not hold a validated token for its full `exp` (15 min –
hours), or revoking an actively-used (cached) token would have no effect until it
expired — defeating revocation for exactly the hot tokens that matter most.
Entries are capped to `AUTH_CACHE_TTL_SECS` (default **30s**, clamped to
`[1, 300]`): a revoked token is re-validated against Redis within that bounded
window. This trades a small, tunable propagation delay for a high cache-hit rate.

## Alternatives considered

- **Keep the token-prefix key.** Rejected — collisions and credential leakage as
  described above.
- **`jti` only.** Cleanest, but requires every issuer to emit `jti`. We keep the
  SHA-256 fallback so tokens without `jti` are still individually revocable.
- **Hash the token into the *value* but key by prefix.** Still collides on the
  key; rejected.
- **Bloom filter / local replica.** Better at very high revocation volumes, but
  adds sync machinery and false-positive handling; revisit only if `EXISTS`
  latency or Redis key cardinality becomes a problem (ADR-0022 "Phase 2").

## Consequences

- Revocation is now **per-token unique** and does not leak token bytes into key
  names.
- One Redis `EXISTS k1 k2` call covers both `jti` and token-hash keys — same one
  RTT as before, only on cache miss.
- **Publisher contract changed.** Anything that previously wrote
  `gateway:revoked:<token-prefix>` must switch to `gateway:revoked:jti:<jti>` or
  `gateway:revoked:token:<sha256_hex>`. No such publisher ships in this repo, so
  there is no in-tree migration; document the contract for downstream auth
  services.
- Cost: one SHA-256 per cache miss (~hundreds of ns), negligible versus the HMAC
  verification already performed.

## Related

- [ADR-0005 — Local JWT validation](0005-local-jwt-validation.md)
- [ADR-0022 — Revocation fail-open](0022-redis-revocation-fail-open.md)
- [`../../services/gateway/edge/rust-ext/src/auth.rs`](../../services/gateway/edge/rust-ext/src/auth.rs) — `revocation_keys`, `check_revocation`
- [docs/SECURITY.md](../SECURITY.md)
