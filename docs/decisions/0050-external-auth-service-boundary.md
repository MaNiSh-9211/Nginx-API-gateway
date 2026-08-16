# ADR-0050 — External auth service owns credentials; gateway validates access JWTs

**Status:** Accepted

## Context

The gateway now has a small built-in testing auth surface, but a real production
system should not let the gateway own passwords, user lifecycle, email
verification, OAuth, refresh tokens, or account recovery.

The user's existing auth service (`auth-advance`) is closer to the real-world
boundary:

- TypeScript / Express auth API
- MongoDB user store
- bcrypt password hashes
- Redis-backed rate limiting
- email verification + password reset
- Google / GitHub OAuth
- access + refresh token pair

## Decision

Use a **separate auth service** as the system of record for identity.

The auth service owns:

- user registration and login
- password hashing using bcrypt with per-password salt and server-side pepper
- email verification and password reset flows
- OAuth provider linking
- refresh tokens and session rotation
- login abuse/rate limiting

The gateway owns:

- validating short-lived **access JWTs** locally on the hot path
- enforcing `iss`, `aud`, `exp`, `nbf`, `iat`, `jti`, and signature
- checking revocation by `jti` / token hash
- injecting sanitized identity headers to upstreams
- routing by `home_region`

## Token contract

Access tokens issued by the auth service must be HS256 and carry:

| Claim | Meaning |
|---|---|
| `sub` | stable user id |
| `iss` | `api-gateway-auth-server` |
| `aud` | `api-gateway-clients` |
| `exp` / `iat` | short lifetime + issue time |
| `jti` | revocation handle |
| `tv` | token version — must match Redis `gateway:user:tv:{sub}` when set (ADR-0053) |
| `home_region` | `EU` / `US` / `AP` / `GLOBAL` for residency routing |
| `type` | `access` (auth service compatibility) |

`JWT_ACCESS_SECRET` in the auth service must match `JWT_SECRET` in the gateway
when using HS256. Refresh tokens use a separate `JWT_REFRESH_SECRET` and are
never accepted by the gateway.

## Password storage contract

The auth service stores:

```text
bcrypt(HMAC-SHA256(PASSWORD_PEPPER, plaintext_password))
```

bcrypt embeds a unique per-password salt in each hash. `PASSWORD_PEPPER` lives
only in env/vault and is never stored with users.

## Alternatives considered

- **Gateway owns passwords.** Rejected. It would put slow credential hashing and
  user lifecycle in the L7 hot-path project.
- **Opaque token introspection.** Strong central control, but adds a network RTT
  to every request and couples gateway availability to auth availability.
- **RS256/JWKS.** Good for larger multi-consumer ecosystems; HS256 is simpler
  here as long as secret distribution is tightly controlled.
- **Long-lived access tokens only.** Rejected. Use short access tokens plus
  refresh-token rotation in the auth service.

## Consequences

- Gateway remains fast and stateless for authenticated traffic.
- Auth service can evolve independently (password policy, MFA, OAuth providers).
- Operators must keep auth `JWT_ACCESS_SECRET` and gateway `JWT_SECRET` in sync
  until/unless the system moves to RS256/JWKS.
- Pepper rotation requires password rehash or forced password reset.

## Related

- [ADR-0005](0005-local-jwt-validation.md)
- [ADR-0038](0038-revocation-key-scheme.md)
- [ADR-0040](0040-identity-headers-to-upstream.md)
- [ADR-0049](0049-bcrypt-salt-pepper-password-storage.md)
