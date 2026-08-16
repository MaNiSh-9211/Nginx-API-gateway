# ADR-0055 — HttpOnly refresh cookies + CSRF double-submit

**Status:** Accepted

## Context

Refresh and access tokens in `localStorage` are fully readable by any XSS on the
SPA origin — a single script injection exfiltrates long-lived sessions
(ADR-0054 audit, P0).

The UAM stack is same-origin: browser → `services/uam/frontend` nginx → gateway →
`services/uam/backend`. That layout supports cookie-based sessions without cross-site
CORS complexity.

## Decision

| Token | Storage | Notes |
|-------|---------|-------|
| **Refresh** | `uam_refresh` HttpOnly cookie, `SameSite=Strict`, path `/api/auth` | Not readable by JS |
| **Access** | SPA memory only | Short-lived; sent as `Authorization: Bearer` |
| **CSRF** | `uam_csrf` readable cookie + `X-CSRF-Token` header | Required on refresh/logout when cookie auth is used |

1. Login, register, verify-email, OAuth exchange set both cookies.
2. Refresh reads refresh token from cookie (or JSON body for API/tests).
3. Logout clears cookies and revokes access JWT via control-plane.
4. Page reload: SPA calls `POST /refresh-token` with cookies before `/me`.
5. JSON body still returns `refreshToken` for scripted tests / non-browser clients.

## Alternatives considered

- **localStorage only** — rejected (XSS = full takeover).
- **Both tokens HttpOnly** — requires BFF to attach Bearer on every gateway call; heavier change.
- **SameSite alone without CSRF header** — acceptable for strict same-origin; double-submit adds defense if cookie path scope widens later.

## Consequences

- API integration tests can keep sending `refreshToken` in JSON (no CSRF).
- Browser clients must use `credentials: 'include'`.
- Production should set `COOKIE_SECURE=true` behind TLS.
