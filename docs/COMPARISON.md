# How This Gateway Compares to Alternatives

An honest comparison. We are not claiming to beat every gateway at everything —
we optimized for **sub-millisecond Rust hot-path overhead**, **lock-free
concurrency**, and **documented trade-offs**.

For *why* we made each choice, see the linked ADRs.

---

## vs Kong (OpenResty + Lua)

| Dimension | Kong | This gateway | Why we differ |
|-----------|------|--------------|---------------|
| Hot-path language | Lua (interpreted) | Rust (compiled, FFI) | ~50–200× faster crypto/parsing — [ADR-0001](decisions/0001-rust-plus-openresty-nginx.md) |
| Plugin ecosystem | 100+ plugins | Custom Rust modules | We trade ecosystem for performance and type safety |
| Config model | DB-backed (Postgres) | GitOps JSON + sidecar | Simpler ops, versioned rollback — [ADR-0011](decisions/0011-control-plane-gitops.md) |
| Maturity | Battle-tested, huge community | Reference implementation | Kong wins on maturity; we win on hot-path design |
| Best for | General API management | Latency-critical, custom L7 logic | |

**When to pick Kong:** You need a plugin marketplace, OAuth plugins, developer
portal, and enterprise support out of the box.

**When to pick this:** You need nanosecond-scale hot-path logic you fully control,
with every decision documented and unit-tested in Rust.

---

## vs Envoy (+ WASM / gRPC)

| Dimension | Envoy | This gateway | Why we differ |
|-----------|-------|--------------|---------------|
| Architecture | C++ proxy + xDS control | NGINX edge + Rust FFI | NGINX's edge maturity (TLS, cache, HTTP/2) — [ADR-0001](decisions/0001-rust-plus-openresty-nginx.md) |
| Custom logic | WASM filters / C++ extensions | Rust cdylib via LuaJIT FFI | Simpler build, no WASM sandbox tax — [ADR-0002](decisions/0002-lua-ffi-data-plane-over-native-module.md) |
| Service mesh | Native (Istio, etc.) | Standalone gateway | We're a gateway, not a mesh sidecar |
| Config | xDS streaming | Sidecar file + ArcSwap | Simpler for non-mesh deployments — [ADR-0012](decisions/0012-config-distribution-sidecar-file-watch.md) |
| Performance | Excellent | Excellent (different profile) | Comparable at scale; different extension model |

**When to pick Envoy:** You're on Kubernetes with Istio/Linkerd, need xDS, gRPC
proxying, or a service mesh.

**When to pick this:** You want NGINX's edge features + Rust hot-path without
adopting a mesh control plane.

---

## vs AWS API Gateway / Azure APIM (managed)

| Dimension | Managed cloud GW | This gateway | Why we differ |
|-----------|------------------|--------------|---------------|
| Ops burden | Zero (managed) | You operate it | Self-hosted = full control + no per-request cloud tax |
| Latency | ~10–50 ms added | ~0.3–0.6 µs Rust overhead | Orders of magnitude less gateway tax |
| Vendor lock-in | High | None | Portable Docker/K8s binary |
| Features | Auth, throttling, SDK gen | Core L7 (auth, WAF, LB, CB, residency) | Managed wins on breadth; we win on latency + control |
| Cost at scale | Per-request pricing | Infra cost only | At billions of req/day, self-hosted wins |

**When to pick managed:** Small/medium traffic, want zero ops, need built-in
API keys, usage plans, SDK generation.

**When to pick this:** Planet-scale traffic where per-request cloud pricing and
added latency are unacceptable.

---

## vs Pure Rust (Pingora / Axum / Hyper)

| Dimension | Pure Rust proxy | This gateway | Why we differ |
|-----------|-----------------|--------------|---------------|
| Edge features | Build yourself | NGINX gives TLS, cache, HTTP/2 free | Faster time-to-production — [ADR-0001](decisions/0001-rust-plus-openresty-nginx.md) |
| Hot path | 100% Rust | Rust via FFI | ~tens of ns Lua hop; negligible vs WAF cost — [ADR-0002](decisions/0002-lua-ffi-data-plane-over-native-module.md) |
| Long-term | Cloudflare's direction | Pragmatic hybrid | Pingora is the future; NGINX+Rust is the present |

**When to pick Pingora:** Greenfield, Rust-native shop, willing to build edge features.

**When to pick this:** You want production-grade edge today with Rust hot-path logic.

---

## vs NGINX alone (no custom code)

| Dimension | NGINX + lua/nginx-js | This gateway | Why we differ |
|-----------|----------------------|--------------|---------------|
| Auth | `auth_request` subrequest | Local JWT in ~50 ns | No per-request subrequest — [ADR-0005](decisions/0005-local-jwt-validation.md) |
| Rate limiting | `limit_req` (per-worker) | Shared-memory cross-worker | Exact node-wide limits — [ADR-0007](decisions/0007-rate-limiting-token-bucket-shared-memory.md) |
| WAF | ModSecurity (heavy) | Aho-Corasick inline | 200 ns vs milliseconds — [ADR-0006](decisions/0006-waf-aho-corasick.md) |
| Config | `nginx -s reload` | ArcSwap hot-swap | Zero-downtime, no connection drop — [ADR-0011](decisions/0011-control-plane-gitops.md) |

**When to pick plain NGINX:** Simple reverse proxy, no custom auth/routing logic.

**When to pick this:** You need programmable L7 with sub-ms overhead.

---

## Summary: our design bets

1. **Rust on the hot path** — safety + speed ([0001](decisions/0001-rust-plus-openresty-nginx.md))
2. **NGINX as the edge** — don't rebuild TLS/cache/HTTP/2 ([0001](decisions/0001-rust-plus-openresty-nginx.md))
3. **Lock-free everything** — no P99 cliff under load ([0003](decisions/0003-lock-free-hot-path.md))
4. **Local-first** — no network on the hot path ([0005](decisions/0005-local-jwt-validation.md), [0007](decisions/0007-rate-limiting-token-bucket-shared-memory.md))
5. **Fail-fast** — backpressure before work ([0010](decisions/0010-backpressure-admission-control.md))
6. **Documented trade-offs** — 21 ADRs, not magic ([decisions/README.md](decisions/README.md))
