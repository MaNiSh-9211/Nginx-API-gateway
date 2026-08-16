# Documentation Index

Everything you need to understand, deploy, and operate this gateway.

## Start here

| If you want to… | Read |
|-----------------|------|
| Understand the **design philosophy** | [`DESIGN_PRINCIPLES.md`](DESIGN_PRINCIPLES.md) |
| Understand **why** each technology was chosen | [`decisions/README.md`](decisions/README.md) — 63 ADRs |
| Cut a production release | [`RELEASE.md`](RELEASE.md) |
| **Am I production ready?** | [`PRODUCTION_READY.md`](PRODUCTION_READY.md) |
| Deploy on AWS / GCP / Azure | [`guides/CLOUD_DEPLOY.md`](guides/CLOUD_DEPLOY.md) |
| See the big picture | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Follow a single request through the system | [`REQUEST_LIFECYCLE.md`](REQUEST_LIFECYCLE.md) |
| Compare us to Kong / Envoy / AWS | [`COMPARISON.md`](COMPARISON.md) |
| Deploy to production | [`PRODUCTION.md`](PRODUCTION.md) |
| Load test + latency budget | [`PERFORMANCE.md`](PERFORMANCE.md) |
| Run day-2 operations | [`OPERATIONS.md`](OPERATIONS.md) |
| Service level objectives | [`SLO.md`](SLO.md) |
| Understand security controls | [`SECURITY.md`](SECURITY.md) |
| Enable mTLS / zero-trust | [`guides/MTLS.md`](guides/MTLS.md) |
| Get started in 5 minutes | [`../README.md`](../README.md) |

## Architecture Decision Records (ADRs)

Each ADR follows: **Context → Decision → Alternatives considered → Consequences**.

| # | Topic |
|---|-------|
| [0001](decisions/0001-rust-plus-openresty-nginx.md) | Rust + OpenResty stack |
| [0002](decisions/0002-lua-ffi-data-plane-over-native-module.md) | Lua-FFI vs native NGINX module |
| [0003](decisions/0003-lock-free-hot-path.md) | Lock-free hot path |
| [0004](decisions/0004-shared-memory-cross-worker-state.md) | Shared memory (mmap) |
| [0005](decisions/0005-local-jwt-validation.md) | Local JWT validation |
| [0006](decisions/0006-waf-aho-corasick.md) | WAF (Aho-Corasick) |
| [0007](decisions/0007-rate-limiting-token-bucket-shared-memory.md) | Rate limiting |
| [0008](decisions/0008-circuit-breaker.md) | Circuit breaker |
| [0009](decisions/0009-load-balancing-consistent-hash-ema.md) | Load balancing |
| [0010](decisions/0010-backpressure-admission-control.md) | Backpressure |
| [0011](decisions/0011-control-plane-gitops.md) | Control plane / GitOps |
| [0012](decisions/0012-config-distribution-sidecar-file-watch.md) | Config sidecar |
| [0013](decisions/0013-secrets-via-environment-not-config-wire.md) | Secrets handling |
| [0014](decisions/0014-data-residency-identity-routing.md) | Data residency |
| [0015](decisions/0015-observability-prometheus-pull.md) | Observability |
| [0016](decisions/0016-tls-termination.md) | TLS termination |
| [0017](decisions/0017-multi-layer-caching.md) | Multi-layer caching |
| [0018](decisions/0018-multi-region-anycast.md) | Multi-region / anycast |
| [0019](decisions/0019-deployment-and-kernel-tuning.md) | Deployment / kernel tuning |
| [0020](decisions/0020-testing-strategy.md) | Testing strategy |
| [0021](decisions/0021-request-correlation-ids.md) | Request correlation IDs |
| [0022](decisions/0022-redis-revocation-fail-open.md) | Redis revocation fail-open |
| [0023](decisions/0023-admin-api-hmac-authentication.md) | Admin API HMAC signing |
| [0024](decisions/0024-health-vs-readiness-probes.md) | Health vs readiness probes |
| [0025](decisions/0025-edge-security-headers.md) | Edge security headers |
| [0026](decisions/0026-structured-json-access-logs.md) | Structured JSON access logs |
| [0027](decisions/0027-trusted-proxy-real-ip-and-slowloris.md) | Trusted proxy IP + slowloris hardening |
| [0028](decisions/0028-redis-authentication-and-isolation.md) | Redis authentication + isolation |
| [0029](decisions/0029-chaos-and-resilience-testing.md) | Chaos + resilience testing |
| [0030](decisions/0030-response-compression-gzip.md) | Response compression (gzip) |
| [0031](decisions/0031-graceful-shutdown-zero-downtime.md) | Graceful shutdown / zero-downtime |
| [0032](decisions/0032-w3c-trace-context-passthrough.md) | W3C traceparent passthrough |
| [0033](decisions/0033-dns-dynamic-upstream-discovery.md) | DNS dynamic upstream discovery |
| [0034](decisions/0034-cache-invalidation-ttl-first.md) | Cache invalidation (TTL-first) |
| [0035](decisions/0035-routing-matchit-radix-tree.md) | Routing: matchit radix tree |
| [0036](decisions/0036-release-gate-automation.md) | Release gate automation |
| [0037](decisions/0037-l1-cache-deferred-l2-primary.md) | L1 cache deferred; L2 primary |
| [0038](decisions/0038-revocation-key-scheme.md) | Revocation key scheme (jti + token hash) |
| [0039](decisions/0039-control-plane-revoke-api.md) | Control-plane POST /revoke API |
| [0040](decisions/0040-identity-headers-to-upstream.md) | Identity headers to upstreams |
| [0041](decisions/0041-refuse-insecure-secrets-at-startup.md) | Refuse insecure secrets at startup |
| [0042](decisions/0042-optional-ebpf-xdp-ddos-filter.md) | Optional eBPF/XDP DDoS filter |
| [0043](decisions/0043-ci-two-tier-testing.md) | CI two-tier testing |
| [0044](decisions/0044-kubernetes-network-segmentation.md) | K8s network segmentation |
| [0045](decisions/0045-helm-production-safe-defaults.md) | Helm production-safe defaults |
| [0046](decisions/0046-docker-multi-stage-build.md) | Docker multi-stage build |
| [0047](decisions/0047-testing-services.md) | Frontend & backend test services |
| [0048](decisions/0048-circuit-breaker-half-open-and-header-stripping.md) | CB half-open CAS + header strip |
| [0049](decisions/0049-bcrypt-salt-pepper-password-storage.md) | bcrypt + salt + pepper password storage |
| [0050](decisions/0050-external-auth-service-boundary.md) | External auth service boundary |

## Guides

| Guide | Topic |
|-------|-------|
| [guides/MTLS.md](guides/MTLS.md) | Mutual TLS + zero-trust |
| [guides/CLOUD_DEPLOY.md](guides/CLOUD_DEPLOY.md) | AWS / GCP / Azure deployment |

## Deployment artifacts

| Path | Purpose |
|------|---------|
| [`../platform/deploy/kubernetes/`](../platform/deploy/kubernetes/) | K8s reference manifests (gateway + sidecar) |
| [`../platform/deploy/helm/api-gateway/`](../platform/deploy/helm/api-gateway/) | Helm chart — gateway stack |
| [`../platform/deploy/helm/uam/`](../platform/deploy/helm/uam/) | Helm chart — UAM stack |
| [`../dev/docker-compose.yml`](../dev/docker-compose.yml) | Single-node local stack |
| [`../dev/docker-compose.multi-region.yml`](../dev/docker-compose.multi-region.yml) | EU/US/AP PoP simulation |
| [`../dev/.env.example`](../dev/.env.example) | Local environment template |

## Legacy / context

| Path | Note |
|------|------|
| [`../architecture_blueprint.md`](../architecture_blueprint.md) | Original vision doc — ADRs are authoritative where they differ |
