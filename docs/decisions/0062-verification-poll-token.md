# ADR-0062: Verification status poll token (anti-enumeration)

## Status

Accepted

## Context

`GET /api/auth/verification-status?email=` returned `verified: true` for known verified
accounts. Even with rate limiting, this allowed attackers to enumerate which emails
have active accounts.

## Decision

1. **Register** (when email verification is required) returns an opaque
   `verificationPollToken` (64-byte hex, 24h TTL in Redis).
2. **POST `/api/auth/verification-status`** accepts `{ pollToken }` and returns the
   real `verified` status for that registration session only.
3. **GET `/api/auth/verification-status`** is deprecated and **always** returns
   `{ success: true, verified: false }` — no database lookup.
4. The UAM frontend polls via POST with the poll token from the register response
   (passed in the verify-email URL as `?poll=`).

## Consequences

- Verified-email enumeration via verification-status is closed.
- Legacy bookmarked `?email=` URLs cannot poll; users can still resend verification.
- Production requires Redis for poll tokens (same as OAuth exchange codes).

## Related

- ADR-0060 (resend-verification anti-enumeration)
- ADR-0058 (Redis fail-closed in production)
