# Architecture Decision Records (ADRs)

This directory captures **every significant design decision** in the gateway,
*why* it was made, and *what alternatives were rejected and why*. Each record is
self-contained and uses the same structure:

- **Status** — Accepted / Superseded / Experimental.
- **Context** — the forces and constraints in play.
- **Decision** — what we chose.
- **Alternatives considered** — the credible options we rejected, and why.
- **Consequences** — the upsides we gain and the costs/risks we accept.

> Why ADRs at all? A "best in the world" gateway is not a pile of clever code —
> it is a set of *defensible* trade-offs. Recording the reasoning lets future
> maintainers change a decision deliberately instead of accidentally, and lets
> reviewers judge the system on its trade-offs rather than guesses.

> **Repository layout:** ADRs may reference legacy paths (`services/gateway/`, `services/uam/`, `testing/`).
> Current monorepo uses top-level folders: `gateway-edge/`, `gateway-sidecar/`, `gateway-control-plane/`,
> `uam-backend/`, `uam-frontend/`, and local orchestration in `dev/`.

## Index

| # | Decision |
|---|----------|
| [0001](0001-rust-plus-openresty-nginx.md) | Core stack: Rust hot path + OpenResty/NGINX |
| [0002](0002-lua-ffi-data-plane-over-native-module.md) | Lua-FFI data plane over a native C-API module |
| [0003](0003-lock-free-hot-path.md) | Lock-free hot path (ArcSwap + atomics + thread-local) |
| [0004](0004-shared-memory-cross-worker-state.md) | Cross-worker state via shared memory (mmap) |
| [0005](0005-local-jwt-validation.md) | Local HS256 JWT validation with LRU + revocation |
| [0006](0006-waf-aho-corasick.md) | WAF built on Aho-Corasick multi-pattern matching |
| [0007](0007-rate-limiting-token-bucket-shared-memory.md) | Rate limiting: shared-memory token bucket |
| [0008](0008-circuit-breaker.md) | Per-upstream + global circuit breaker |
| [0009](0009-load-balancing-consistent-hash-ema.md) | Load balancing: consistent hash + EMA latency |
| [0010](0010-backpressure-admission-control.md) | Backpressure / admission control runs first |
| [0011](0011-control-plane-gitops.md) | Control plane: GitOps, ArcSwap, signed pushes |
| [0012](0012-config-distribution-sidecar-file-watch.md) | Config distribution: sidecar + file watch |
| [0013](0013-secrets-via-environment-not-config-wire.md) | Secrets via environment, never the config wire |
| [0014](0014-data-residency-identity-routing.md) | Data residency via identity-based routing |
| [0015](0015-observability-prometheus-pull.md) | Observability: Prometheus pull + structured logs + OTel |
| [0016](0016-tls-termination.md) | TLS termination strategy |
| [0017](0017-multi-layer-caching.md) | Multi-layer caching (L1 thread-local + L2 proxy_cache) |
| [0018](0018-multi-region-anycast.md) | Multi-region / anycast edge topology |
| [0019](0019-deployment-and-kernel-tuning.md) | Deployment model + kernel/ulimit tuning |
| [0020](0020-testing-strategy.md) | Testing strategy |
| [0021](0021-request-correlation-ids.md) | Request correlation IDs (X-Request-ID) |
| [0022](0022-redis-revocation-fail-open.md) | Redis revocation fail-open |
| [0023](0023-admin-api-hmac-authentication.md) | Admin API HMAC signing |
| [0024](0024-health-vs-readiness-probes.md) | Health vs readiness probes |
| [0025](0025-edge-security-headers.md) | Edge security headers |
| [0026](0026-structured-json-access-logs.md) | Structured JSON access logs |
| [0027](0027-trusted-proxy-real-ip-and-slowloris.md) | Trusted proxy IP + slowloris hardening |
| [0028](0028-redis-authentication-and-isolation.md) | Redis authentication + network isolation |
| [0029](0029-chaos-and-resilience-testing.md) | Chaos + resilience testing |
| [0030](0030-response-compression-gzip.md) | Response compression (gzip) |
| [0031](0031-graceful-shutdown-zero-downtime.md) | Graceful shutdown / zero-downtime |
| [0032](0032-w3c-trace-context-passthrough.md) | W3C traceparent passthrough |
| [0033](0033-dns-dynamic-upstream-discovery.md) | DNS dynamic upstream discovery |
| [0034](0034-cache-invalidation-ttl-first.md) | Cache invalidation (TTL-first) |
| [0035](0035-routing-matchit-radix-tree.md) | Routing: matchit radix tree |
| [0036](0036-release-gate-automation.md) | Release gate automation |
| [0037](0037-l1-cache-deferred-l2-primary.md) | L1 cache deferred; L2 NGINX cache primary |
| [0038](0038-revocation-key-scheme.md) | Revocation key scheme: jti + SHA-256 token hash |
| [0039](0039-control-plane-revoke-api.md) | Control-plane `POST /revoke` API |
| [0040](0040-identity-headers-to-upstream.md) | Identity headers to upstreams |
| [0041](0041-refuse-insecure-secrets-at-startup.md) | Refuse insecure secrets at startup |
| [0042](0042-optional-ebpf-xdp-ddos-filter.md) | Optional eBPF/XDP L4 DDoS filter |
| [0043](0043-ci-two-tier-testing.md) | CI two-tier testing (unit vs Docker E2E) |
| [0044](0044-kubernetes-network-segmentation.md) | K8s network segmentation (NetworkPolicy) |
| [0045](0045-helm-production-safe-defaults.md) | Helm production-safe defaults |
| [0046](0046-docker-multi-stage-build.md) | Docker multi-stage slim runtime |
| [0047](0047-testing-services.md) | Frontend & backend test services |
| [0048](0048-circuit-breaker-half-open-and-header-stripping.md) | CB half-open CAS fix + identity header strip |
| [0049](0049-bcrypt-salt-pepper-password-storage.md) | bcrypt + salt + pepper password storage |
| [0050](0050-external-auth-service-boundary.md) | External auth service boundary |
| [0051](0051-kubernetes-pod-security-context.md) | Kubernetes pod security context (restricted baseline) |
| [0052](0052-uam-service-integration.md) | UAM frontend + backend integration with gateway |

## Conventions

- The **production data plane** is `gateway-edge/rust-ext` (Rust cdylib) loaded by
  `gateway-edge/lua/gateway.lua`.
- **Deployment checklist:** [`../PRODUCTION.md`](../PRODUCTION.md)
- **Architecture map:** [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- **Request lifecycle:** [`../REQUEST_LIFECYCLE.md`](../REQUEST_LIFECYCLE.md)
- **Operations runbook:** [`../OPERATIONS.md`](../OPERATIONS.md)
- "Hot path" = the per-request code in `gateway-edge/rust-ext/src/lib.rs::process_request`.
- Latency figures are design targets backed by the chosen algorithms; measure on
  your own hardware (ADR-0020).
