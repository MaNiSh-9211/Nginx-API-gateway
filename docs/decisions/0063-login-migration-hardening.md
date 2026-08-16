# ADR-0063: Login anti-enumeration and migration hardening

## Status

Accepted

## Context

Security audit found remaining leaks and bypasses:

- Login returned distinct errors for OAuth accounts and unverified emails (password oracle).
- Migration finalize returned raw `refreshToken` in JSON, bypassing ADR-0055.
- `getRefreshFromRequest()` accepted body refresh when HttpOnly mode was enabled.
- Migration `EMAIL_EXISTS` exposed victim account metadata (`displayName`, `provider`, etc.).
- Migration routes had no rate limits; login limiter failed open on Redis errors.

## Decision

1. **Login** — wrong password, OAuth account, and unverified email all return `401` with
   `{ message: "Invalid email or password", code: "AUTH_FAILED" }`.
2. **Migration finalize** — use `setAuthCookies`, `publicTokenFields`, `persistSessionTokens`.
3. **Refresh from body** — rejected when `AUTH_OMIT_REFRESH_IN_BODY=true`.
4. **Migration EMAIL_EXISTS** — generic warning only; no `existingAccountInfo`.
5. **Migration routes** — `migrationLimiter` (15/hour) on init/resend/finalize; `authLimiter` on verify.
6. **Login limiter** — on Redis error, degrade to in-memory tracking instead of failing open.

## Consequences

- Login page no longer auto-redirects unverified users (anti-enumeration trade-off).
- Users can still use verify-email / resend links without confirming account existence.
- Migration UX still supports confirm-override without profiling the target account.

## Related

- ADR-0055 (HttpOnly refresh)
- ADR-0062 (verification poll token)
