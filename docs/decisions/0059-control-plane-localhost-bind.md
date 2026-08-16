# ADR-0059: Control-plane localhost bind + UAM frontend cookie-mode fixes

## Status

Accepted

## Context

1. **Control plane admin port** was published on `0.0.0.0:18085` in Docker Compose.
   Any device on the LAN could reach `/config`, `/revoke`, and `/metrics` unless
   `CONFIG_READ_TOKEN` and HMAC were configured — unnecessary attack surface for
   dev laptops on coffee-shop Wi‑Fi.

2. **UAM frontend OAuth / verify flows** still required `refreshToken` in JSON
   before treating login as successful. After ADR-0055 (`AUTH_OMIT_REFRESH_IN_BODY`),
   those flows silently failed even when HttpOnly cookies were set correctly.

3. **MigrationPage** called `api.request()` which does not exist on `ApiClient`,
   breaking migration finalization at runtime.

## Decision

1. Docker Compose binds control-plane to `127.0.0.1:${CONTROL_PLANE_PORT}` only.
2. OAuth callback and email-verify pages succeed when `accessToken` is present;
   refresh remains in HttpOnly cookie only.
3. Add `finalizeMigration()` to `ApiClient`; MigrationPage uses typed migration
   API methods instead of a non-existent generic `request()`.

## Consequences

- Remote machines cannot hit the control plane on a dev laptop (correct).
- `test.ps1` still works via `localhost:18085`.
- Production K8s uses ClusterIP — no change.
