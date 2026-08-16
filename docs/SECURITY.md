# Security Model

How this gateway defends itself and your backends. Each control links to the ADR
that explains *why* we chose it over alternatives.

---

## Threat model (in scope)

| Threat | Mitigation |
|--------|------------|
| Injection (SQLi, XSS, path traversal) | WAF + NGINX traversal guard — [ADR-0006](decisions/0006-waf-aho-corasick.md) |
| WAF body evasion via large payload | First 8KB read from spooled body file when it exceeds `client_body_buffer_size` (Lua hot path) — [ADR-0006](decisions/0006-waf-aho-corasick.md) |
| WAF body evasion via embedded NUL byte | Body crosses the FFI length-delimited (ptr+len), not as a C string, so a payload after a NUL is still scanned; non-UTF-8 bodies decoded lossily so ASCII patterns remain visible — [ADR-0006](decisions/0006-waf-aho-corasick.md) |
| Worker crash via crafted multi-byte input | Char-boundary-safe truncation before WAF scan (`panic = abort` makes a slice panic a DoS) — [ADR-0006](decisions/0006-waf-aho-corasick.md) |
| Stolen/forged JWT | HS256 + strict claims + revocation — [ADR-0005](decisions/0005-local-jwt-validation.md) |
| Algorithm confusion (`alg:none`, RS256→HS256) | Reject any `alg` ≠ HS256 — [ADR-0005](decisions/0005-local-jwt-validation.md) |
| Token replay after logout | Redis revocation (`jti` + token hash) — [ADR-0038](decisions/0038-revocation-key-scheme.md), [ADR-0039](decisions/0039-control-plane-revoke-api.md); UAM calls `/revoke` on logout and password reset |
| OAuth tokens in browser URL | One-time code exchange (`/oauth/exchange`) — tokens never in query string — [ADR-0052](decisions/0052-uam-service-integration.md) |
| Brute-force / credential stuffing | Per-IP WAF rate limit + per-user rate limit — [ADR-0006](decisions/0006-waf-aho-corasick.md), [ADR-0007](decisions/0007-rate-limiting-token-bucket-shared-memory.md) |
| Scanner/bot traffic | User-Agent blocklist (sqlmap, nikto, …) — [ADR-0006](decisions/0006-waf-aho-corasick.md) |
| DDoS / traffic spike | Backpressure → 503 — [ADR-0010](decisions/0010-backpressure-admission-control.md) |
| Upstream failure cascade | Circuit breaker — [ADR-0008](decisions/0008-circuit-breaker.md) |
| Unauthorized config change | HMAC admin signature + rate limit — [ADR-0011](decisions/0011-control-plane-gitops.md) |
| Admin rate-limit bypass via spoofed `X-Forwarded-For` | Limiter keyed on real TCP `peer_addr`, not forwarded headers — [ADR-0023](decisions/0023-admin-api-hmac-authentication.md) |
| Secret leakage via config API | Secrets from env only — [ADR-0013](decisions/0013-secrets-via-environment-not-config-wire.md) |
| Cross-region data transfer | Identity-based residency 403 — [ADR-0014](decisions/0014-data-residency-identity-routing.md) |
| Header injection / smuggling | CRLF sanitization on JWT identity fields — [ADR-0005](decisions/0005-local-jwt-validation.md) |
| TLS downgrade / weak ciphers | TLS 1.2+ only, modern cipher suite — [ADR-0016](decisions/0016-tls-termination.md) |
| Clickjacking / MIME sniffing | Security headers (CSP, X-Frame-Options, …) — [ADR-0016](decisions/0016-tls-termination.md) |
| Metrics enumeration | `/metrics` restricted to RFC1918 — `gateway-locations.conf` |

---

## Out of scope (use edge + dedicated tools)

| Threat | Recommendation |
|--------|----------------|
| Volumetric DDoS (L3/L4) | Anycast + optional eBPF XDP (`platform/monitoring/ebpf/`) — [ADR-0018](decisions/0018-multi-region-anycast.md), [ADR-0042](decisions/0042-optional-ebpf-xdp-ddos-filter.md) |
| Spoofed `X-User-Id` from client | Stripped at ingress; gateway re-sets from JWT — [ADR-0040](decisions/0040-identity-headers-to-upstream.md), [ADR-0048](decisions/0048-circuit-breaker-half-open-and-header-stripping.md) |
| Deep WAF (OWASP CRS full ruleset) | External WAF (Cloudflare, AWS WAF) in front — [ADR-0006](decisions/0006-waf-aho-corasick.md) |
| Bot management (CAPTCHA, device fingerprint) | Dedicated bot-management service |
| mTLS for all clients | [mTLS guide](guides/MTLS.md) — enable `ssl_verify_client` — [ADR-0016](decisions/0016-tls-termination.md) |

---

## Secrets inventory

| Secret | Where it lives | Never in |
|--------|----------------|----------|
| `JWT_SECRET` | Gateway env / K8s Secret | Config API, config file, logs |
| `ADMIN_API_KEY` | Control plane env | HTTP responses, Git |
| TLS private key | Mounted cert volume | Docker image layers |
| Grafana password | Env / Secret manager | Defaults in prod |

→ [ADR-0013](decisions/0013-secrets-via-environment-not-config-wire.md)

---

## JWT requirements (tokens we accept)

| Claim / check | Value |
|---------------|-------|
| `alg` | `HS256` only |
| `exp` | Required, must be in the future |
| `nbf` | If present, must be in the past |
| `iat` | If present, must be < 24 h old |
| `iss` | `api-gateway-auth-server` (configurable) |
| `aud` | `api-gateway-clients` (configurable) |
| `jti` | If present, used as the preferred revocation handle |
| `home_region` | `EU` / `US` / `AP` / `GLOBAL` for routing |
| Signature | HMAC-SHA256, constant-time compare |
| Revocation | Redis keys `gateway:revoked:jti:<jti>` (preferred) or `gateway:revoked:token:<sha256_hex>` — checked via one `EXISTS`, **fail-open** if Redis is down ([ADR-0022](decisions/0022-redis-revocation-fail-open.md), [ADR-0038](decisions/0038-revocation-key-scheme.md)); signature/`exp` checks still apply |

### Revoking a token (publisher contract)

The auth server / control plane revokes a token by setting either Redis key,
with a TTL equal to the token's remaining lifetime:

```
SET gateway:revoked:jti:<jti> 1 EX <seconds_until_exp>
# or, when the token has no jti:
SET gateway:revoked:token:<sha256_hex_of_full_jwt> 1 EX <seconds_until_exp>
```

The old `gateway:revoked:<token-prefix>` scheme was removed in v0.6.1 because the
constant HS256 header made prefixes collide and leaked token bytes
([ADR-0038](decisions/0038-revocation-key-scheme.md)).

### Revoking via control plane (reference publisher)

```http
POST /revoke
X-Admin-Signature: sha256=<hmac_sha256_hex_of_body>
Content-Type: application/json

{"jti": "session-abc", "ttl_secs": 3600}
```

Or revoke a specific token without `jti`:

```json
{"token": "<full-jwt-without-Bearer>", "ttl_secs": 3600}
```

See [ADR-0039](decisions/0039-control-plane-revoke-api.md). In production the
auth server may call this API or write Redis directly using the same keys.

---

## Network boundaries

```
Internet ──▶ [TLS] ──▶ Gateway :8080/:8443
                          │
              internal ───┼─── Control plane :8081 (no public port in compose)
                          ├─── Redis :6379 (internal only)
                          ├─── Prometheus :9090
                          └─── Upstreams (private network)
```

In production: gateway is the **only** public-facing service. Control plane and
Redis stay on a private network/VPC. Redis adds optional `requirepass` auth via
`REDIS_PASSWORD` ([ADR-0028](decisions/0028-redis-authentication-and-isolation.md));
config mutations require an HMAC signature
([ADR-0023](decisions/0023-admin-api-hmac-authentication.md)).

---

## Hardening checklist

- [ ] Replace all default secrets (`.env.example` → real values)
- [ ] Set non-default `ADMIN_API_KEY` (enables HMAC verification)
- [ ] Mount production TLS certificates
- [ ] Restrict `/metrics` to monitoring network (already RFC1918-only)
- [ ] Set `GATEWAY_REGION` per PoP for residency enforcement
- [ ] Enable mTLS if zero-trust required
- [ ] Run Redis with `requirepass` in production
- [ ] Review WAF patterns for your API surface
- [ ] Enable Prometheus alert rules (`platform/monitoring/prometheus/rules/`)
