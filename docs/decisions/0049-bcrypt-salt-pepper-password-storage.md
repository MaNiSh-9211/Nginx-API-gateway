# ADR-0049 — bcrypt + salt + pepper for user password storage

**Status:** Accepted

## Context

The testing auth service (`services/demo/backend`) originally minted JWTs
without verifying user credentials — fine for gateway demos, not for modeling
real login. Passwords must never be stored in plaintext or reversible encryption.

We need a scheme that survives database leaks and follows industry practice.

## Decision

Store passwords in the auth service using **three layers**:

| Layer | What | Where it lives |
|-------|------|----------------|
| **bcrypt** | Adaptive hash (cost factor 12 default) | `password_hash` in user store |
| **Salt** | Random per password (16 bytes) | Embedded in bcrypt string (`$2b$12$…`) |
| **Pepper** | Server secret `PASSWORD_PEPPER` | Env / vault only — **never** in user file |

### Hashing pipeline

```
material = HMAC-SHA256(pepper, plaintext_password)  // hex digest
password_hash = bcrypt.hash(material, cost=12)      // salt generated inside bcrypt
```

Verify: recompute `material`, then `bcrypt.compare(material, stored_hash)`.

### Migration & rollout (how this is done in the real world)

You can never flip a password-hashing scheme in one shot — every row already on
disk was hashed the old way, and re-deriving them is impossible (that's the
point of a one-way hash). So introducing a pepper is a **rolling migration**, not
a rewrite:

1. **Pepper is optional, not required.** If `PASSWORD_PEPPER` is unset the service
   degrades to plain `bcrypt(password)` and logs a startup warning. This prevents
   a missing env var from turning every login/registration into a `500`.
2. **Verify accepts both schemes.** On login the service first tries the current
   (peppered) digest, then falls back to the legacy `bcrypt(plaintext)` digest.
   A legacy match is still a successful login.
3. **Transparent rehash-on-login.** When a legacy hash matches, `verifyPassword`
   returns `needsRehash = true`; the caller re-hashes the just-verified plaintext
   under the current scheme and saves it. Users migrate silently as they sign in —
   no forced password reset, no lockout.

This is implemented in the production auth service in
`server/src/utils/password.util.ts` (`verifyPassword → { match, needsRehash }`)
and wired into the Mongoose `comparePassword` method, which performs the
best-effort rehash inside a `try/catch` so a migration failure can never block a
valid login.

### API

- `POST /auth/register` — `{ username, password, home_region }` → 201
- `POST /auth/login` — `{ username, password }` → `{ token, claims }` (HS256 JWT)

User records on disk (`USER_STORE_PATH`, Docker volume `backend-auth-data`) store
only `password_hash`, `home_region`, `created_at`.

### Security details

- Dummy bcrypt hash compared when username missing (timing uniformity).
- User file written atomically with mode `0600`.
- Dev default pepper logged as warning (parity with ADR-0041).
- Gateway hot path unchanged — still validates JWT locally (ADR-0005).

## Alternatives considered

- **Plain bcrypt(password)** without pepper. Weaker if only the DB leaks; pepper
  requires an additional secret from env/vault.
- **Argon2id.** Stronger memory-hard KDF; bcrypt is ubiquitous, well-audited in
  Node (`bcrypt` npm), and sufficient at cost 12 for this auth service.
- **scrypt.** Good but less standard in Node ecosystem than bcrypt for small services.
- **Store pepper in DB.** Defeats the purpose; pepper must not ship with ciphertext.
- **Separate salt column.** Redundant — bcrypt embeds salt in the hash string.
- **Hash passwords in the gateway.** Wrong boundary — gateway validates tokens,
  auth service owns credentials (ADR-0047).

## Consequences

- Leaked `users.json` alone is insufficient to crack passwords without `PASSWORD_PEPPER`.
- Introducing or rotating the pepper does **not** lock users out: legacy hashes are
  accepted and transparently re-hashed on next login (see Migration above).
- `BCRYPT_COST` tunable (10–15) via env for hardware/SLA trade-off.
- Unit tests in `users.test.js` (demo service) and
  `server/src/scripts/test-auth-contract.ts` (production auth service) lock
  register/login/pepper/legacy-migration and JWT-claim behavior.

## Related

- [ADR-0047](0047-testing-services.md) · [ADR-0013](0013-secrets-via-environment-not-config-wire.md)
- [`../../services/demo/backend/users.js`](../../services/demo/backend/users.js)
