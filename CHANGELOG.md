# Changelog

All notable changes to this API gateway project.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Added

- Local (process-local) Redis circuit breaker + dependency health monitor across all three
  services, per `requirements.md` §2–§28:
  - `gateway-edge/rust-ext/src/redis_cb.rs` — fast + statistical detectors, rolling
    p99/error/timeout window, hysteresis, recovery jitter, HALF_OPEN probes, concurrency cap;
    wired into rate-limit and cache lookups, `/health` `redis_circuit`, `/metrics` `redis_*`.
  - `gateway-control-plane/src/redis_cb.rs` — same design; protects admin-nonce de-dupe and
    revocation-key writes with bounded timeouts (`CP_REDIS_TIMEOUT_MS`, default 1000ms, clamp
    50–5000), `/health` `redis_circuit`, `/metrics` `redis_*`.
  - `uam-backend/src/config/redisCircuitBreaker.ts` — same design (`REDIS_CB_*` env vars);
    all cache + rate-limit Redis commands route through the breaker, `/metrics` `uam_redis_*`,
    fail-closed rate limiting, fail-open cache, login limiter 503 in production when degraded.
- Prometheus metrics for Redis dependency health: `redis_*` (edge/control-plane) and
  `uam_redis_*` (uam-backend): requests/success/errors/timeouts, circuit open/half-open/
  rejected totals, state, in-flight, rolling p99, rolling error rate.
- Control plane durable config store (`gateway-control-plane/src/store.rs`): config
  revisions + audit trail persisted to Postgres in an isolated `control_plane` schema
  (ADR-0011 — the control plane's OWN operational state, never uam-backend's `public`
  user schema). Durable-first `POST /config` / `POST /config/rollback` (mutation
  rejected 503 if the write fails), boot-time history restore so rollback survives
  restarts, `GET /config/history` from Postgres, new `GET /config/audit`, `/health`
  `postgres` field. Hot-path `GET /config` stays on ArcSwap (~2 ns).

### Fixed

- UAM rate limiters: Redis store initialization, distinct per-limiter Redis prefixes, dev/test
  relax limits (`UAM_RELAX_AUTH_LIMITS`) — fixes false 429s during E2E runs.
- Documentation and scripts aligned to flat monorepo layout (`gateway-edge/`, `dev/`, etc.).
- Multi-region dev stack uses dedicated Prometheus config (`prometheus.multi-region.yml`).
- Release-check scripts point at `dev/test.ps1` and `dev/tests/e2e.sh`.
- Full observability stack: Prometheus scrapes gateway, control-plane, config-sidecar, redis-exporter;
  UAM overlay adds uam-backend `/metrics`, mongodb-exporter, nginx-exporter + Grafana dashboards.

### Security

- [ADR-0061](docs/decisions/0061-email-logging-hygiene.md) — SMTP/email logging
  hygiene; no secrets or token URLs in production logs.
- [ADR-0060](docs/decisions/0060-resend-verification-anti-enumeration.md) — uniform
  resend-verification response prevents email enumeration.
- [ADR-0059](docs/decisions/0059-control-plane-localhost-bind.md) — control-plane
  localhost-only in Compose; UAM frontend OAuth/verify/migration fixes for cookie mode.
- [ADR-0058](docs/decisions/0058-uam-production-guards.md) — UAM logout body-only
  token revoke, OAuth Redis fail-closed in prod, verification-status rate limit,
  `UAM_REFUSE_INSECURE_SECRETS` startup guard.
- [ADR-0057](docs/decisions/0057-config-read-token.md) — optional `CONFIG_READ_TOKEN`
  protects `GET /config` and `/config/history`; UAM overlay enables it + `REVOCATION_FAIL_CLOSED=1`.
- Fix `COOKIE_SECURE` no longer implied by `NODE_ENV=production` — local HTTP Docker
  must set `COOKIE_SECURE=false` explicitly or browsers drop session cookies (ADR-0055).
- MongoDB healthcheck uses container env vars; `scripts/reset-uam-mongo.ps1` for volume migration.

## [0.7.7] — 2026-06-30

### Added

- [ADR-0056](docs/decisions/0056-uam-helm-chart.md) — standalone Helm chart
  `platform/deploy/helm/uam/` (backend, frontend, MongoDB StatefulSet). Total: **56 ADRs**.

### Security

- MongoDB authentication in `docker-compose.uam.yml` (`MONGO_ROOT_USER` /
  `MONGO_ROOT_PASSWORD`).
- `AUTH_OMIT_REFRESH_IN_BODY` — production mode omits refresh token from JSON
  when HttpOnly cookies are used (ADR-0055); now enabled in `docker-compose.uam.yml`.

## [0.7.6] — 2026-06-30

### Security

- [ADR-0055](docs/decisions/0055-httponly-refresh-cookies.md) — refresh token in
  HttpOnly `SameSite=Strict` cookie; access token memory-only in SPA; CSRF
  double-submit on cookie-based refresh/logout. Total: **55 ADRs**.
- Redis optional `REDIS_PASSWORD` in Docker Compose (gateway, control-plane, UAM
  already support ACL auth via env).

## [0.7.5] — 2026-06-30

### Security

- [ADR-0054](docs/decisions/0054-oauth-binding-backend-tv.md) — block OAuth
  provider hijack (no silent local→Google/GitHub switch); enforce `tv` in UAM
  backend middleware; atomic refresh rotation; password reset fails if Redis tv
  publish fails; session rate limits on refresh/logout.
- UAM frontend nginx: CSP + `Cross-Origin-Opener-Policy` on SPA shell.
- Auto-verify register flow: frontend stores tokens and routes to dashboard.

## [0.7.4] — 2026-06-30

### Added

- [ADR-0053](docs/decisions/0053-token-version-floor.md) — `tv` JWT claim +
  Redis floor `gateway:user:tv:{sub}` for O(1) kill-all-sessions on password
  reset; complements per-JTI revocation. Total: **53 ADRs**.

### Security

- UAM: `tokenVersion` on User model; bumped on password reset; published to Redis
  on every session issuance.
- Gateway: rejects access tokens when `tv` does not match the published floor.

## [0.7.3] — 2026-06-30

### Added

- [ADR-0050](docs/decisions/0050-external-auth-service-boundary.md) — production
  boundary for external auth service: auth owns credentials/refresh sessions;
  gateway validates short-lived access JWTs locally.
- Documented token contract for integrating `auth-advance` with the gateway:
  `sub`, `iss`, `aud`, `exp`, `iat`, `jti`, `home_region`, `type=access`.
- Total: **50 ADRs**.

### Changed

- Updated `auth-advance` service (external path) to:
  - hash passwords as `bcrypt(HMAC-SHA256(PASSWORD_PEPPER, password))`;
  - emit gateway-compatible access JWT claims;
  - document `PASSWORD_PEPPER`, `JWT_ISSUER`, `JWT_AUDIENCE`, `BCRYPT_COST`, and
    `DEFAULT_HOME_REGION` in its `.env.example`.

### Added

- **UAM services** (`services/uam/backend/`, `services/uam/frontend/`, `docker-compose.uam.yml`) —
  integrated User Access Management from `auth-advance`: Express + MongoDB backend
  issues gateway-compatible access JWTs; React SPA served behind nginx with
  same-origin proxy to the gateway (`/api/*` → gateway → uam-backend or business
  APIs). MongoDB added as optional overlay dependency. Dev `AUTO_VERIFY_EMAIL`
  for SMTP-less register/login in Docker. See [ADR-0052](docs/decisions/0052-uam-service-integration.md).
  Total: **52 ADRs**.
- [ADR-0052](docs/decisions/0052-uam-service-integration.md) — UAM frontend/backend
  integration pattern (same-origin proxy, auth through gateway WAF).
- [ADR-0051](docs/decisions/0051-kubernetes-pod-security-context.md) — Kubernetes
  pod security context: `seccompProfile`, `automountServiceAccountToken: false`,
  locked-down Rust sidecars (`readOnlyRootFilesystem`, `capabilities.drop: [ALL]`),
  gateway `allowPrivilegeEscalation: false` (OpenResty master still needs root for
  worker privilege drop).

### Changed

- **Revocation Redis lookups reuse a per-worker connection**
  (`services/gateway/edge/rust-ext/src/auth.rs`): `check_revocation` previously did
  `Client::open` + a fresh TCP handshake on every cache miss, then dropped the
  connection — a wasted round trip per request and a socket/FD exhaustion risk
  under load (more pronounced now that cache entries are TTL-bounded). It now
  keeps one thread-local connection with bounded connect + I/O timeouts (50ms),
  reconnecting only when a command fails. Added a timeout-sanity test (gateway
  suite now 62).

### Fixed

- **Admin API replay attacks** (`services/gateway/control-plane/src/main.rs`): HMAC alone let an
  attacker replay a captured `POST /config` or `POST /revoke` indefinitely.
  Mutations now require `X-Admin-Timestamp` (±5 min), `X-Admin-Nonce` (one-time,
  Redis `SET NX`), and HMAC over `timestamp||nonce||body`. UAM `revoke.service`
  updated to match. Dev `ADMIN_API_KEY` default still skips checks (ADR-0023).
- **OAuth tokens leaked via URL query string**
  (`services/uam/backend`, `services/uam/frontend`): Google/GitHub callbacks redirected to
  `/oauth-callback?accessToken=...&refreshToken=...`, exposing tokens in browser
  history, server logs, and Referer headers. OAuth now redirects with a one-time
  `code` (Redis, 120s TTL); the SPA exchanges it via `POST /api/auth/oauth/exchange`.
- **Password reset left access JWTs valid on gateway**
  (`services/uam/backend`): reset cleared refresh tokens only. UAM now tracks recent access
  `jti`s per user and revokes them all via control-plane `/revoke` on password reset.
- **Logout did not revoke access JWTs in the gateway**
  (`services/uam/backend/src/services/revoke.service.ts`, `auth.controller.ts`): logout only
  removed refresh tokens from MongoDB; short-lived access tokens remained valid on
  all gateway nodes until `exp`. UAM now publishes revocation to the control plane
  (`POST /revoke`, ADR-0039) with `jti` + full token hash and TTL matched to
  remaining lifetime. Best-effort — logout never fails if Redis/control-plane is
  down. E2E covered in `scripts/test-uam.ps1`.
- **WAF body inspection bypassable with an embedded NUL byte**
  (`services/gateway/edge/lua/gateway.lua`, `services/gateway/edge/rust-ext/src/lib.rs`): the request body
  crossed the FFI as a C string (`const char*`) and Rust read it with
  `CStr::from_ptr().to_bytes()`, which stops at the first NUL. A body beginning
  with `\0` (or containing one before the payload) was seen as *empty* by the
  WAF, so injection/XSS after the NUL sailed through. The body is now passed
  length-delimited (`ptr + body_len`) and reconstructed via
  `String::from_utf8_lossy`, so interior NULs no longer truncate it and ASCII
  attack patterns inside non-UTF-8/binary bodies are still scanned (previously a
  non-UTF-8 body was discarded entirely by `from_utf8().unwrap_or("")`). Added a
  WAF regression test; total gateway tests now 68.
- **`kid`-based JWT key rotation was completely non-functional**
  (`services/gateway/edge/rust-ext/src/config.rs`, `gateway/nginx.conf`): the control plane
  strips `jwt_keys` from `GET /config` (secret material), and the gateway only
  injected `JWT_SECRET` from the environment — so `jwt_keys` was *always* empty
  and `auth.rs` rejected every token carrying a `kid` header. The gateway now
  sources `jwt_keys` from a `JWT_KEYS` env var (JSON `kid`→secret), declared in
  `nginx.conf` (NGINX otherwise scrubs the worker env) and wired through the Helm
  chart and raw k8s manifests as Secret material. Malformed `JWT_KEYS` is ignored
  with a log line (never crashes a worker). Added unit tests; see ADR-0005.
- **`AUTH_CACHE_TTL_SECS` tunable was silently ignored**
  (`gateway/nginx.conf`): the revocation-cache TTL knob added in this release
  read `std::env::var("AUTH_CACHE_TTL_SECS")`, but the var was never declared in
  `nginx.conf`, so NGINX scrubbed it from the worker environment and the value
  always fell back to the 30 s default. Declared it (and `JWT_KEYS`) so the knob
  actually takes effect.
- **GatewayDown alert never fired** (`platform/monitoring/prometheus/rules/gateway-alerts.yml`):
  `gateway_up == 0` cannot trigger when the process is down because the metric
  goes absent (no scrape), not 0. Switched to Prometheus's synthetic
  `up{job="gateway"} == 0`. Added matching `ControlPlaneDown` alert. Guarded
  `GatewayHighErrorRate` against divide-by-zero when there is no traffic.
- **Redis password stored in a ConfigMap (plaintext)** (`platform/deploy/helm/api-gateway`):
  when `redis.password` was set, it was rendered into the `gateway-env` ConfigMap
  and passed as a plain env value in the control-plane spec — ConfigMaps are not
  encrypted at rest and are visible via `kubectl get cm -o yaml`. The password now
  renders into the `gateway-secrets` Secret and is injected via `secretKeyRef` in
  both the gateway and control-plane (ADR-0013); only non-secret Redis fields stay
  in the ConfigMap. Validated with `helm template` + `helm lint`.
- **Security headers stripped from all proxied traffic** (`gateway/gateway-locations.conf`):
  the 7 security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options,
  etc.) were declared with `add_header` at server level, but `location /` declares
  its own `add_header X-Cache-Status`. Per nginx inheritance rules, a context that
  defines any `add_header` drops all inherited ones — so the entire main traffic
  path served responses with **none** of the security headers. Switched them to
  `more_set_headers` (ngx_headers_more, bundled with OpenResty), which runs in the
  header-filter phase and applies uniformly to every location and to Lua error
  responses. Validated with `openresty -t`.
- **Revocation defeated for cached tokens** (`services/gateway/edge/rust-ext/src/auth.rs`): the
  per-worker JWT cache stored validated tokens until their full `exp` (15 min –
  hours) and revocation is only checked on a cache *miss*. So revoking an
  actively-used (cached) token had no effect until it naturally expired. Positive
  cache entries are now capped to `AUTH_CACHE_TTL_SECS` (default 30s, clamped
  `[1,300]`), bounding the revocation propagation delay. Added 4 unit tests
  (gateway suite now 61).
- **Anonymous requests 403'd on regional nodes** (`services/gateway/edge/rust-ext/src/router.rs`):
  data-residency routing defaulted requests with no `home_region` to `"US"`, so on
  a strictly-pinned non-US node (e.g. `GATEWAY_REGION=EU`) every unauthenticated
  request was rejected with 403 — including the login/register endpoints that must
  be reachable without a token. Anonymous traffic carries no user data and now
  resolves to the node's own region (GLOBAL nodes fall back to the always-present
  `"US"` pool); authenticated cross-region requests are still strictly 403'd.
  Extracted a pure `resolve_region()` with 5 unit tests (gateway suite now 57).
- **Admin rate-limit bypass + memory DoS** (`services/gateway/control-plane/src/main.rs`): the
  per-IP mutation limiter keyed on `realip_remote_addr()`, which actix derives
  from the client-supplied `X-Forwarded-For`/`Forwarded` headers. An attacker
  could rotate that header to bypass the brute-force limit entirely and flood the
  bucket map with unbounded distinct keys (memory exhaustion). Now keyed on the
  real TCP `peer_addr`, and the bucket map prunes elapsed windows so it stays
  bounded. Added 3 unit tests (control-plane suite now 19 tests).
- **Anonymous rate-limit bucket collapse** (`services/gateway/edge/rust-ext/src/rate_limit.rs`):
  anonymous requests hashed to a single fixed bucket (key `0`) via
  `user_key.map(fx_hash).unwrap_or(0)`, so every anonymous client node-wide shared
  one counter — a single client could throttle all anonymous users (and it
  double-counted the WAF's per-IP limit). Per ADR-0007 the per-user limiter now
  applies to authenticated requests only; anonymous traffic is limited per-IP in
  the WAF. Added 4 regression tests (gateway suite now 52 tests).
- **WAF worker-crash DoS** (`services/gateway/edge/rust-ext/src/waf.rs`): body and User-Agent
  were sliced at a fixed byte offset (`&body[..8192]`, `&ua[..512]`). A multi-byte
  UTF-8 char straddling that offset panics, and with `panic = "abort"` that aborts
  the whole NGINX worker (remotely triggerable). Added char-boundary-safe
  truncation + 3 regression tests (gateway suite now 48 tests).
- **WAF body-inspection bypass** (`services/gateway/edge/lua/gateway.lua`): bodies larger than
  `client_body_buffer_size` (128k) are spooled to a temp file, so
  `get_body_data()` returned `nil` and the WAF scanned an *empty* body — an
  attacker could pad a payload past 128k to skip body inspection. The hot path now
  reads the first 8KB (the WAF scan window) from the spooled body file.
- **Auth migration safety** (`auth-advance`): the initial pepper change would have
  thrown `500` when `PASSWORD_PEPPER` was unset and permanently locked out every
  pre-existing user (legacy `bcrypt(password)` hashes can't match a peppered
  compare). Reworked into a real-world rolling migration:
  - new `server/src/utils/password.util.ts` makes the pepper **optional** and
    `verifyPassword` returns `{ match, needsRehash }`;
  - legacy un-peppered hashes still authenticate and are **transparently
    re-hashed on next login** (best-effort, never blocks login);
  - startup warns on a missing/dev-default pepper.
  - Contract tests: `server/src/scripts/test-auth-contract.ts` — 16/16 passing
    (round-trip, legacy migration, wrong-password, no-pepper mode, JWT claims).

## [0.7.2] — 2026-06-30

### Added

- **bcrypt + salt + pepper** password storage in `backend-test-service`
  ([ADR-0049](docs/decisions/0049-bcrypt-salt-pepper-password-storage.md)):
  - Salt: per-password, embedded in bcrypt hash (`$2b$12$…`)
  - Pepper: `PASSWORD_PEPPER` env secret, mixed via HMAC-SHA256 before bcrypt
  - `POST /auth/register` and `POST /auth/login` (returns gateway JWT)
  - Persistent user store on `backend-auth-data` Docker volume
  - Unit tests: `npm test` in `services/demo/backend`
- Test console: Register / Login UI (password field + buttons)
- Total: **49 ADRs**.

## [0.7.1] — 2026-06-30

### Security

- **Strip spoofed identity headers** at ingress (`ngx.req.clear_header` for
  `X-User-Id` / `X-Home-Region`) before JWT validation; upstream only receives
  gateway-injected values ([ADR-0048](docs/decisions/0048-circuit-breaker-half-open-and-header-stripping.md)).

### Fixed

- **Circuit breaker half-open race** — when cooldown elapsed, workers that lost
  the OPEN→HALF_OPEN CAS no longer treat the circuit as open, so multi-worker
  recovery probes work ([ADR-0048](docs/decisions/0048-circuit-breaker-half-open-and-header-stripping.md)).
- Seven new unit tests in `circuit_breaker.rs`.

### Added

- E2E regression: spoofed `X-User-Id: attacker` with valid JWT for `alice` →
  upstream echoes `alice` (`test.ps1` + `e2e.sh`).
- CI validates `docker-compose.testing.yml` overlay.
- Total: **48 ADRs**.

## [0.7.0] — 2026-06-30

### Added

- **Testing services** ([ADR-0047](docs/decisions/0047-testing-services.md)) under `testing/`:
  - `backend-test-service` (Node/Express) — realistic sample upstream that echoes
    gateway-injected identity headers, serves JSON resources, and mints dev JWTs at
    `POST /auth/dev-token` (HS256 with the shared secret, no `kid` so the gateway
    uses its primary key).
  - `frontend-test-service` (nginx + static SPA) — a test console at
    `http://localhost:8090` that reverse-proxies `/gw`, `/cp`, `/auth` so the
    browser stays same-origin (no CORS, secret never reaches the browser). Mint
    tokens; fire authed / anonymous / WAF / traversal / burst requests; run
    revoke-then-retry.
- **`docker-compose.testing.yml`** overlay — wires both services and moves
  `echo-backend` behind a `legacy-echo` profile so the real backend takes over the
  upstream aliases.
- **`/ratelimit-test/` route** (limit 5 rps) in the dev snapshot so the burst test
  reliably demonstrates `429`s. Snapshot bumped to `v1.0.1`.
- Total: **47 ADRs**.

### Fixed

- **E2E suite** (`test.ps1`) — routing and config-push tests now work with both the
  default `echo-backend` and the opt-in `backend-test-service` overlay; config
  push/rollback uses the live version instead of hardcoded `v1.0.0`.

### Verified

- Full console path: token mint → routing → JWT validation → identity-header
  injection (`X-User-Id`/`X-Home-Region`) → WAF (SQLi + traversal) → rate-limit
  (5×200 / 15×429) → revoke (`200 → 401`). 13/13 smoke checks pass.

## [0.6.2] — 2026-06-30

### Added

- **`docs/PRODUCTION_READY.md`** — single-page production gate (automated + human checklist).
- [ADR-0046](docs/decisions/0046-docker-multi-stage-build.md) — Docker multi-stage build rationale.
- Total: **46 ADRs**.

### Fixed

- README test counts updated (57 unit / 33 E2E / 12 CI smoke).
- Helm/K8s control-plane `REDIS_*` env for `POST /revoke` (prior pass).

## [0.6.1] — 2026-06-30

### Security

- **Revocation key hardening** — revocation lookups now key on `jti`
  (`gateway:revoked:jti:<jti>`) or a SHA-256 hash of the full token
  (`gateway:revoked:token:<sha256_hex>`), checked in one `EXISTS` round trip.
  Replaces the previous truncated-token-prefix key, which collided across
  HS256 tokens (constant header) and leaked token bytes into Redis key names.
  See [ADR-0038](docs/decisions/0038-revocation-key-scheme.md).
- JWT `jti` claim now parsed and used as the preferred revocation handle.

### Fixed

- `scripts/release-check.ps1` PowerShell parser errors (path escape + string
  interpolation); Helm lint now falls back to `alpine/helm` via Docker when the
  `helm` CLI is absent. See [ADR-0036](docs/decisions/0036-release-gate-automation.md).

### Added

- **Control-plane `POST /revoke`** — HMAC-signed API to publish `jti` or
  token-hash revocations to Redis ([ADR-0039](docs/decisions/0039-control-plane-revoke-api.md)).
- E2E revocation tests in `test.ps1` (§10) — 33 total cases.
- **Identity headers** `X-User-Id` / `X-Home-Region` forwarded to upstreams
  ([ADR-0040](docs/decisions/0040-identity-headers-to-upstream.md)).
- **Startup secret guard** — warn on dev `JWT_SECRET`; optional
  `GATEWAY_REFUSE_INSECURE_SECRETS=1` ([ADR-0041](docs/decisions/0041-refuse-insecure-secrets-at-startup.md)).
- ADR-0045 (Helm production defaults), nightly CI workflow, Helm/K8s Redis env
  on control plane for `POST /revoke`. See ADR-0036–0039.
- `scripts/release-check.sh` — Linux/macOS release gate (ADR-0036).
- `GatewayConfigNotReady` Prometheus alert; eBPF/XDP optional L4 filter documented.
- `.env` files added to `.gitignore` (secrets hygiene).

## [0.6.0] — 2026-06-30

### Added

- **37 Architecture Decision Records** — every major design choice documented
- **Helm chart** (`platform/deploy/helm/api-gateway/`) for production Kubernetes
- **Release gate** (`scripts/release-check.ps1`) — automated pre-tag validation (ADR-0036)
- **k6 load tests** via Docker (`scripts/load-test.ps1`) — ~2,360 req/s smoke benchmark
- **Chaos test suite** (`tests/chaos_test.ps1`) — Redis partition, upstream crash, gateway restart
- **CI E2E job** — `tests/e2e.sh` on GitHub Actions
- **Guides**: mTLS ([guides/MTLS.md](docs/guides/MTLS.md)), cloud deploy ([guides/CLOUD_DEPLOY.md](docs/guides/CLOUD_DEPLOY.md))
- **PERFORMANCE.md** — latency budget + load test results
- **DESIGN_PRINCIPLES.md** — seven architectural pillars
- Redis ACL username + TLS (`REDIS_USERNAME`, `REDIS_TLS` / `rediss://`)
- W3C `traceparent` passthrough to upstreams (ADR-0032)
- `REVOCATION_FAIL_CLOSED` for high-assurance tenants
- Weighted consistent-hash load balancing
- Recursive WAF URL decoding (double-encoding bypass fix)
- Control-plane HMAC unit tests + secret-stripping verification
- Config-sidecar atomic-write unit tests
- Grafana dashboard + Prometheus alert rules

### Fixed

- Load balancer returns `host:port` address (not logical name) for `proxy_pass`
- L2 cache bypass for authenticated requests (wrong-user cache poisoning)
- Backpressure double-release bug in telemetry path
- Config distribution (`jwt_secret` injected from env, not config wire)
- Region code mismatch (`GATEWAY_REGION` vs JWT `home_region`)
- Config sidecar volume permissions + healthcheck

### Security

- HMAC-signed config mutations with admin rate limiting
- Per-IP WAF rate limit (configurable `WAF_IP_RATE_LIMIT_RPS`)
- Edge security headers + TLS 1.2/1.3 hardening
- Secrets never in `GET /config` responses

## [0.5.0] — Earlier

- Initial Rust hot path (WAF, JWT, routing, rate limit, circuit breaker, LB)
- OpenResty + Lua-FFI data plane
- Control plane with GitOps config API
- Config sidecar + file watch distribution

[0.6.0]: #v060-2026-06-30
