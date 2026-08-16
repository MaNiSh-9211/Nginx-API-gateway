# ADR-0047 — Frontend & backend test services

**Status:** Accepted

## Context

The base stack ships a generic `echo-backend` (ealen/echo-server) as the upstream
behind the gateway. It is enough to prove a request was proxied, but it cannot:

- render the **identity** the gateway injected (`X-User-Id`, `X-Home-Region`),
- serve realistic JSON resources for an interactive client,
- mint JWTs the gateway will accept, or
- give a human a way to *drive* the gateway (auth, WAF, rate limits, residency,
  revocation) without hand-crafting `curl` commands.

We want a self-contained way to exercise the full data path end-to-end, both for
manual QA and for demos, without weakening the production stack.

## Decision

Add an **opt-in testing overlay** (`docker-compose.testing.yml`) with two services
under `testing/`:

### 1. `backend-test-service` (Node 20 + Express)

A single small process playing two roles:

- **Sample upstream** on `:8080` (drop-in for the echo server). It echoes the
  gateway-injected identity + tracing headers and serves `/api/v1/users`,
  `/api/v1/orders`, `/public/status`, `/health`. The overlay gives it **all** the
  upstream network aliases (`api-eu-1` … `ap-backend-1`), so real gateway routing
  lands here.
- **Dev JWT minter** at `POST /auth/dev-token`. The gateway validates HS256
  locally with a shared secret ([ADR-0006](0006-jwt-local-validation.md)), so for
  local testing we mint tokens with that same `JWT_SECRET`, including
  `iss`/`aud`/`exp`/`nbf`/`iat`/`jti` matching the gateway's expectations. Guarded
  by `AUTH_DEV_TOKENS` and reached **directly** (never through the gateway).

### 2. `frontend-test-service` (nginx + static SPA)

A dependency-free web console (`http://localhost:8090`) that reverse-proxies:

| Browser path | Proxied to | Purpose |
|---|---|---|
| `/gw/*` | `gateway:8080` | all gated traffic (WAF, JWT, rate limit, routing) |
| `/cp/*` | `control-plane:8081` | revocation API |
| `/auth/*` | `backend-test-service:8080` | dev token minting |

It can mint a token, fire authenticated/anonymous/WAF/traversal/burst requests,
and run a **revoke-then-retry** flow against the control-plane `/revoke`
([ADR-0039](0039-control-plane-revoke-api.md)), showing status, latency, response
headers, and body.

`echo-backend` is moved behind a `legacy-echo` Compose profile so it no longer
starts when the overlay is applied (its aliases would otherwise collide).

## Alternatives considered

- **Browser mints JWTs directly.** Would require shipping `JWT_SECRET` to the
  browser — rejected. The secret stays server-side in the token minter.
- **Frontend calls gateway/control-plane cross-origin.** Forces CORS handling
  onto the gateway purely for a test tool. The nginx **same-origin reverse proxy**
  avoids CORS entirely and keeps the gateway config production-clean.
- **Rust/Actix backend** (matching the rest of the repo). Express is faster to
  read and modify for a throwaway test surface; the service is explicitly *not*
  part of the production data plane.
- **React/Vite SPA.** A single hand-written `index.html` + `app.js` has zero build
  step, builds instantly in an `nginx:alpine` image, and is trivial to audit.
- **Fold into base `docker-compose.yml`.** Kept as a separate overlay so the
  production-shaped base stack stays minimal and the test surface is opt-in.

## Consequences

- One command brings up a real, clickable end-to-end environment:
  `docker compose -f docker-compose.yml -f docker-compose.testing.yml up --build`.
- The token minter is dev-only. Swapping in a **real auth service** is a two-step
  change: point the frontend `/auth` proxy at it and set `AUTH_DEV_TOKENS=0`. The
  gateway is unaffected — it only requires the JWT be signed with `JWT_SECRET` and
  carry the expected `iss`/`aud`.
- UI revocation works in dev because the control-plane skips admin-signature
  checks when `ADMIN_API_KEY` is the default ([control-plane `verify_admin_signature`](../../services/gateway/services/gateway/control-plane/src/main.rs)).
  With a real admin key, revocation must be signed (out of scope for the browser tool).
- Nothing in the testing overlay runs in production; the base stack is unchanged.

## Related

- [`../../testing/README.md`](../../testing/README.md)
- [`../../docker-compose.testing.yml`](../../docker-compose.testing.yml)
- [ADR-0006](0006-jwt-local-validation.md) · [ADR-0039](0039-control-plane-revoke-api.md) · [ADR-0040](0040-identity-headers-to-upstream.md)
