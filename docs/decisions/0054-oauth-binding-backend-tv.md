# ADR-0054 — OAuth provider binding and backend token-version enforcement

**Status:** Accepted

## Context

Two gaps remained after gateway-side JWT validation (ADR-0050, ADR-0053):

1. **OAuth account takeover** — logging in with Google/GitHub could silently
   change a `local` user's `provider`, locking them out of password login.
2. **Defense in depth** — UAM backend accepted access JWTs without comparing
   `tv` to `user.tokenVersion`, so any caller reaching `services/uam/backend` on the
   internal network bypassed password-reset invalidation.

## Decision

1. **OAuth provider binding** — if an email already exists with
   `provider: local` or a *different* OAuth provider, reject the OAuth login
   with a clear error. No silent provider switching.
2. **Backend `tv` check** — `authenticate` middleware compares JWT `tv` to
   `user.tokenVersion`; stale tokens receive 401 even when the gateway is
   bypassed.
3. **Refresh rotation** — mint new token pair *before* removing the old
   refresh token (`rotateSessionTokens` with conditional `findOneAndUpdate`).
4. **Password reset** — fail with 503 if `publishTokenVersion` cannot confirm
   the Redis floor (sessions must not appear reset while tokens remain valid).
5. **Session rate limits** — dedicated limiter on `/refresh-token` and `/logout`.

## Consequences

- Users cannot "upgrade" local → OAuth without an explicit linking flow (future).
- Password reset requires Redis availability for a successful response.
