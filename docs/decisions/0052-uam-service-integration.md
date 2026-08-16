# ADR-0052 — UAM service integration (frontend + backend)

**Status:** Accepted

## Context

Production API gateways sit in front of many services. User Access Management
(UAM) — registration, login, token issuance, refresh, logout — is a **separate
deployable** from the gateway itself. The gateway validates short-lived access
JWTs locally; it does not own credentials (ADR-0050).

We integrated the existing `auth-advance` codebase as two services in this
monorepo for local/dev orchestration:

- **`services/uam/backend`** — Express + MongoDB + Redis (credentials, tokens)
- **`services/uam/frontend`** — React SPA behind nginx (same-origin proxy)

In production these run as independent deployments; Docker Compose only
co-locates them for developer ergonomics.

## Decision

### Service boundaries

| Concern | Owner |
|---------|--------|
| Passwords, refresh sessions, OAuth, email verify | `services/uam/backend` |
| WAF, rate limits, JWT validation, routing, residency | Gateway |
| Browser UX, same-origin API calls | `services/uam/frontend` (nginx) |

### Traffic flow

```
Browser → uam-frontend:80
            ├─ /api/*  → gateway:8080 → uam-backend (auth) or business APIs
            └─ /gw/*   → gateway:8080 (optional direct gateway prefix)
```

Auth endpoints (`/api/auth/*`) are registered in the control plane as
`uam-auth` with **`require_auth: false`**. The gateway still applies WAF and
per-IP rate limits. Protected business routes (`/api/v1/*`) use
`require_auth: true`; the gateway validates JWTs and injects `X-User-Id` /
`X-Home-Region`.

### Token contract

Access tokens issued by `services/uam/backend` must match gateway expectations:

- Algorithm: **HS256**
- Claims: `sub`, `iss=api-gateway-auth-server`, `aud=api-gateway-clients`,
  `exp`, `iat`, `jti`, `home_region`, `type=access`
- `JWT_ACCESS_SECRET` (uam-backend) **==** `JWT_SECRET` (gateway)

Refresh tokens stay on the auth service; the gateway never sees them.

### OAuth (no tokens in URL)

OAuth callbacks redirect to `/oauth-callback?code=<one-time>` only. Tokens are
stored in Redis (120s TTL) and exchanged via `POST /api/auth/oauth/exchange`.
This prevents access/refresh tokens appearing in browser history, Referer
headers, or server access logs.

### Session revocation

- **Logout:** `POST /revoke` with `jti` + token hash; access token in JSON body
  (not `Authorization` — avoids gateway LRU re-cache on the revoke request).
- **Password reset:** revokes all tracked access `jti`s for the user.
- **JTI tracking:** last 20 access `jti`s per user in MongoDB for bulk revoke.

### Same-origin frontend (why not CORS to gateway?)

Enterprise SPAs are served from a CDN or ingress on one origin. API calls use
relative paths (`/api/...`) proxied to the gateway. Benefits:

- No CORS preflight on every request
- No exposed internal service hostnames in the browser
- OAuth redirect URLs stay on the public frontend origin
- Matches how billion-dollar SaaS consoles are deployed (UI tier ≠ API tier)

## Alternatives considered

- **Auth bypasses gateway (direct to uam-backend).** Lower latency, but loses
  WAF/rate-limit/observability on login — the highest-abuse surface. Rejected.
- **Gateway embeds auth logic.** Violates ADR-0050; couples credential storage
  to the data plane. Rejected.
- **Opaque tokens + introspection on every request.** Correct for multi-party
  trust, but adds network RTT to the hot path. Rejected for access tokens;
  gateway uses local JWT validation (ADR-0005).

## Consequences

- Operators must keep `JWT_ACCESS_SECRET` and `JWT_SECRET` in sync (Secret
  manager / Helm — ADR-0013).
- MongoDB is a new dependency when the UAM overlay is enabled.
- OAuth providers must whitelist the **frontend** callback URL
  (`CLIENT_URL/api/auth/.../callback`), not the gateway port directly.
- Revocation: logout clears refresh tokens in MongoDB; gateway best-effort
  Redis revocation applies to access tokens (ADR-0038). **`services/uam/backend` calls
  `POST /revoke` on the control plane** during logout (jti + token hash, HMAC-signed
  when `ADMIN_API_KEY` is not the dev default). The access token is sent in the
  **logout JSON body**, not the `Authorization` header — otherwise the gateway
  would re-cache the JWT as valid on the same request that publishes revocation.

## References

- [ADR-0050](0050-external-auth-service-boundary.md) — auth/gateway boundary
- [ADR-0005](0005-local-jwt-validation.md) — local JWT validation
- [ADR-0013](0013-secrets-via-environment-not-config-wire.md) — secrets handling
- `docker-compose.uam.yml`, `services/uam/backend/`, `services/uam/frontend/`
