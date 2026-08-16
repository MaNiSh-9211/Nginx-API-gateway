# ADR-0041 — Refuse known-insecure secrets at worker startup

**Status:** Accepted

## Context

ADR-0013 keeps secrets in environment variables, not on the config wire. That
does not stop operators from deploying with **documented dev defaults**
(`super_secret_key_for_hmac_sha256_change_in_prod`, etc.). A gateway accepting
forged JWTs in production because someone forgot to rotate `JWT_SECRET` is a
common, catastrophic misconfiguration.

## Decision

On each worker's `init_extension()`:

1. **Warn** (stderr → NGINX error log) if `JWT_SECRET` is empty or matches a
   built-in list of known dev/default values.
2. **Abort the worker** if `GATEWAY_REFUSE_INSECURE_SECRETS=1` (or `true`) is
   set **and** the secret is insecure — pods fail readiness instead of serving
   traffic with a known key.

Dev / Docker Compose omit `GATEWAY_REFUSE_INSECURE_SECRETS` so tests keep
working with `.env.example` values. Production Helm/K8s sets it to `1`.

**Control plane parity:** on startup, warn when `ADMIN_API_KEY` is a known dev
default; exit if `CONTROL_PLANE_REFUSE_INSECURE_SECRETS=1` (same opt-in hard fail).

## Alternatives considered

- **Silent acceptance.** Rejected — fails open on the worst class of misconfig.
- **Always abort on default secret.** Too harsh for local `docker compose` and
  CI without extra env wiring; opt-in hard fail is the compromise.
- **Gateway-only check.** Insufficient — unsigned config/revoke APIs also need
  a non-default admin key ([ADR-0023](0023-admin-api-hmac-authentication.md)).

## Consequences

- Production deploys should set `GATEWAY_REFUSE_INSECURE_SECRETS=1` and
  `CONTROL_PLANE_REFUSE_INSECURE_SECRETS=1` in Helm/K8s.
- Error log noise in dev is intentional — reminds operators to rotate before cutover.
- Does not validate secret *strength* (length/entropy); only blocks known bad values.

## Related

- [ADR-0013 — Secrets via environment](0013-secrets-via-environment-not-config-wire.md)
- [docs/PRODUCTION.md](../PRODUCTION.md)
- [docs/RELEASE.md](../RELEASE.md)
