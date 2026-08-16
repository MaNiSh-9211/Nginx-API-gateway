# ADR-0058: UAM production startup guards

## Status

Accepted

## Context

The UAM backend holds credentials, mints gateway JWTs, and publishes revocations.
Several endpoints and code paths had dev-friendly fallbacks that are unsafe at
enterprise scale:

1. **Logout** still accepted `Authorization: Bearer` as a fallback for the
   access token to revoke. A request through the gateway with that header would
   validate and LRU-cache the JWT in the same request that revokes it (ADR-0038).
2. **OAuth one-time codes** fell back to an in-process `Map` when Redis was
   unavailable — fine for single-node dev, wrong for multi-replica production.
3. **`GET /verification-status`** had no rate limit — email enumeration vector.
4. **JWT / pepper / admin defaults** were only warned via pepper check; no
   unified refuse-at-startup hook like the gateway (ADR-0041).

## Decision

1. **Logout** revokes access tokens from `{ accessToken }` in the JSON body
   only — never from `Authorization`.
2. **OAuth exchange codes** require Redis when `NODE_ENV=production`; no
   in-memory fallback in that mode.
3. **`GET /verification-status`** uses the same `emailCheckLimiter` as
   `/check-email`.
4. Introduce `UAM_REFUSE_INSECURE_SECRETS=1` (opt-in hard fail) checked at
   startup for `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PASSWORD_PEPPER`,
   and `ADMIN_API_KEY` known dev defaults.
5. Helm UAM chart sets `auth.refuseInsecureSecrets: true` by default.

## Consequences

- API clients must send `accessToken` in the logout body (frontend already does).
- OAuth login fails closed in production if Redis is down — correct for HA.
- Local Docker Compose omits `UAM_REFUSE_INSECURE_SECRETS` so dev stacks keep
  starting with documented default secrets.
