# Design Principles

How this gateway is built and *why* it is structured this way. Every principle
links to Architecture Decision Records (ADRs) that document alternatives we
rejected.

---

## 1. Hot path is sacred

Every microsecond on the request path matters at scale. The data plane is:

- **Rust** for decisions (auth, WAF, routing, limits, LB)
- **OpenResty** for I/O (TLS, proxy, cache, HTTP semantics)
- **Lua** only as a thin FFI bridge ([ADR-0002](decisions/0002-lua-ffi-data-plane-over-native-module.md))

No locks on the hot path ([ADR-0003](decisions/0003-lock-free-hot-path.md)). Shared
state uses mmap atomics ([ADR-0004](decisions/0004-shared-memory-cross-worker-state.md)).

---

## 2. Fail fast, degrade gracefully

Order matters. We reject cheaply before expensive work:

1. Backpressure — overload → 503 ([ADR-0010](decisions/0010-backpressure-admission-control.md))
2. WAF — attack → 403 ([ADR-0006](decisions/0006-waf-aho-corasick.md))
3. Auth — bad token → 401 ([ADR-0005](decisions/0005-local-jwt-validation.md))
4. Rate limit → 429 ([ADR-0007](decisions/0007-rate-limiting-token-bucket-shared-memory.md))
5. Circuit breaker → skip bad upstreams ([ADR-0008](decisions/0008-circuit-breaker.md))

When upstreams fail, L2 cache may serve stale responses (`proxy_cache_use_stale`)
([ADR-0017](decisions/0017-multi-layer-caching.md)).

---

## 3. Defense in depth

No single control is trusted alone:

| Layer | Control | ADR |
|-------|---------|-----|
| Edge | TLS 1.2/1.3, security headers | [0016](decisions/0016-tls-termination.md), [0025](decisions/0025-edge-security-headers.md) |
| Request | WAF, path traversal block | [0006](decisions/0006-waf-aho-corasick.md) |
| Identity | JWT + optional Redis revocation | [0005](decisions/0005-local-jwt-validation.md), [0022](decisions/0022-redis-revocation-fail-open.md) |
| Policy | Data residency routing | [0014](decisions/0014-data-residency-identity-routing.md) |
| Admin | HMAC-signed config pushes | [0023](decisions/0023-admin-api-hmac-authentication.md) |
| Secrets | Env / vault only | [0013](decisions/0013-secrets-via-environment-not-config-wire.md) |

---

## 4. Config is data, not code

Routing and upstream topology live in **versioned JSON** pushed through a control
plane ([ADR-0011](decisions/0011-control-plane-gitops.md)). Gateways pull via a
**sidecar + file watch** ([ADR-0012](decisions/0012-config-distribution-sidecar-file-watch.md))
and hot-swap with `ArcSwap` — no process restart, no NGINX reload for new backends
([ADR-0009](decisions/0009-load-balancing-consistent-hash-ema.md)).

---

## 5. Observable by default

- Prometheus metrics on `/metrics` ([ADR-0015](decisions/0015-observability-prometheus-pull.md))
- JSON access logs with `req_id` ([ADR-0026](decisions/0026-structured-json-access-logs.md))
- `X-Request-ID` on every response ([ADR-0021](decisions/0021-request-correlation-ids.md))
- Grafana dashboard + alert rules in `platform/monitoring/`

---

## 6. Every trade-off is written down

We chose **Lua-FFI over a native NGINX module**, **local JWT over introspection**,
**fail-open revocation over outage**, **proxy_pass + resolver over balancer_by_lua**
— each for documented reasons.

Full index: [**52 ADRs**](decisions/README.md). When you change the system,
add or supersede an ADR — don't let the code drift from its rationale.

---

## 7. Production readiness is provable

- E2E suite with real HS256 JWTs (`test.ps1`) — 33 cases
- Rust unit tests per crate (ADR-0020) — gateway + control-plane
- k6 load tests via Docker (`scripts/load-test.ps1`) — [PERFORMANCE.md](PERFORMANCE.md)
- Chaos scenarios (`tests/chaos_test.ps1`) — [ADR-0029](decisions/0029-chaos-and-resilience-testing.md)
- Docker Compose reference stack + Helm chart (`platform/deploy/helm/`)
- Checklist: [PRODUCTION.md](PRODUCTION.md)

---

## Comparison to other gateways

See [COMPARISON.md](COMPARISON.md) for an honest matrix vs Kong, Envoy, AWS API
Gateway, Pingora, and plain NGINX — including where we deliberately trade
features for latency and operational simplicity.
