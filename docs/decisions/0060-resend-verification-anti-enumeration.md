# ADR-0060: Resend verification anti-enumeration

## Status

Accepted

## Context

`POST /api/auth/resend-verification` returned distinct responses:

- `404 User not found` — reveals the email is not registered
- `400 Email already verified` — reveals the email exists and is verified
- `200 Verification email sent` — reveals unverified account exists

This allowed attackers to enumerate registered emails despite rate limits on
other endpoints.

`POST /api/auth/forgot-password` already uses a uniform success message
(ADR best practice).

## Decision

Always return HTTP 200 with the same JSON body:

```json
{
  "success": true,
  "message": "If the account exists and is unverified, a verification email has been sent"
}
```

When the user does not exist, is already verified, or uses OAuth-only auth,
perform no side effects but return the same response. SMTP failures also
return the generic success body (logged server-side).

## Consequences

- Clients cannot distinguish unknown, verified, or OAuth-only addresses via
  this endpoint.
- Legitimate users still receive mail when applicable.
- Rate limiting via `authLimiter` remains in place.
