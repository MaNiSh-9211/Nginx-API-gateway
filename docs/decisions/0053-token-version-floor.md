# ADR-0053 — Token version floor for instant session invalidation

**Status:** Accepted

## Context

Per-JTI revocation (ADR-0038) works well for logout and refresh rotation, but
password reset must invalidate **all** outstanding access tokens immediately —
including JTIs that were never tracked (e.g. tokens issued before the 20-JTI
window filled, or tokens from another device).

Revoking every possible JTI is impossible. A monotonic **token version** on the
user record provides O(1) kill-all-sessions semantics.

## Decision

1. **UAM backend** stores `tokenVersion` (default `0`) on each user.
2. Every access JWT carries claim `tv` equal to the user's `tokenVersion` at
   issuance time.
3. On login, register, refresh, and OAuth success, UAM publishes
   `SET gateway:user:tv:{sub} <version>` in Redis (no TTL).
4. On password reset, UAM increments `tokenVersion`, publishes the new value,
   revokes tracked JTIs (defence in depth), and clears refresh tokens.
5. **Gateway** after signature verification:
   - `GET gateway:user:tv:{sub}`
   - If key **missing** → accept (legacy users / pre-migration tokens)
   - If key **present** → `tv` claim must equal stored value exactly; missing
     or stale `tv` → reject
   - Redis unavailable → same policy as revocation (`REVOCATION_FAIL_CLOSED`)
   - **Cache hits re-check the floor** — unlike revocation (bounded by
     `AUTH_CACHE_TTL_SECS`), a bumped version must take effect immediately even
     when the JWT LRU already holds the token.

## Why not only JTI tracking?

| Approach | Kill-all on password reset | Logout single session |
|---|---|---|
| JTI list (bounded) | Incomplete if >N active tokens | Yes |
| Token hash revoke | Needs token body | Yes |
| **Token version floor** | **Yes, O(1)** | No (use JTI revoke) |

Use **both**: version floor for account-wide events; JTI for per-session logout.

## Alternatives considered

- **Shorter access TTL only** — does not help for tokens still within window.
- **Opaque introspection on every request** — adds RTT and couples availability.
- **Global user blocklist key** — equivalent to version floor but less explicit.

## Consequences

- Existing tokens without `tv` are rejected once Redis has a floor for that user
  (after first login post-deploy).
- Redis must be shared between UAM (publisher) and gateway (reader), same as
  revocation keys.
