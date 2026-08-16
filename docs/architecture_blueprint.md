# Ultra-Scale API Gateway — Architecture Blueprint

> **Authoritative source:** This blueprint is the original high-level vision and
> is kept for context. Where it differs from the implementation, the
> **[Architecture Decision Records](docs/decisions/README.md)** and the
> [README](README.md) are authoritative. Notably, the shipped system uses a
> **config sidecar + file watch** (not per-worker HTTP polling) and
> **shared-memory** rate limiting (not Redis on the hot path) — see ADR-0012 and
> ADR-0007. The region check is cached, not read from env per request (ADR-0014).

## 1. ROUTING ENGINE
- **Detailed Design**: Runs at the Gateway Layer (L7) in the Rust hot-path (`router.rs`). Resolves requests using longest-prefix matching on URI paths. Parses JWTs for identity-based claims (`home_region`).
- **Code Sketch**: Uses `ArcSwap` for zero-allocation access to routing rules (`GLOBAL_CONFIG`). Checks `std::env::var("GATEWAY_REGION")` and explicitly returns a 403 Forbidden on data residency mismatch.
- **Scaling Strategy**: Scales perfectly per CPU core (1 worker per core) since routing operates purely on in-memory rules with no shared mutable state. Handles 10 to 10,000 nodes without performance degradation.
- **Failure Handling**: If a node crashes, NGINX restarts the worker. Since state is stateless or fetched from `ArcSwap`, recovery is instantaneous.
- **Performance Analysis**: Path matching and region validation adds <15ns latency. Negligible CPU/memory footprint.
- **Configuration Example**:
  ```yaml
  routes:
    - path_prefix: /api/v1/users
      service_name: user_service
  ```
- **Testing Strategy**: Unit tests on path matching. Load testing with diverse JWT region claims to verify strict routing under high RPS.

## 2. AUTHENTICATION
- **Detailed Design**: Runs at L7 in Rust (`auth.rs`). Performs lightweight JWT validation using HMAC-SHA256 (`kid` lookup). External auth and mTLS are delegated to upstream identity services or NGINX layers.
- **Code Sketch**: Tokens are parsed and validated using `jsonwebtoken` crate, and a localized LRU cache avoids re-parsing the same token repeatedly.
- **Scaling Strategy**: Completely decentralized via stateless JWTs. Keys are replicated via Control Plane, so 10,000 nodes can independently validate auth locally.
- **Failure Handling**: If the Control Plane is down, nodes continue to use the last cached JWT keys indefinitely (ArcSwap).
- **Performance Analysis**: ~50ns overhead for cached tokens; ~3μs for fresh tokens.
- **Configuration Example**:
  ```yaml
  jwt_keys:
    key_v1: "secret123"
  ```
- **Testing Strategy**: Fuzz testing token headers. Load testing auth hit/miss cache ratios.

## 3. RATE LIMITING
- **Detailed Design**: Combines L1 (in-memory, DashMap per-worker) and L2 (Redis). Uses a localized token bucket algorithm mapped per `user_id` or IP address.
- **Code Sketch**: `rate_limit.rs` checks local atomic counters. A background sync thread pushes increments to Redis every few seconds, blending local speed with global consistency.
- **Scaling Strategy**: At 10,000 nodes, global sync handles drift using approximate synchronization to prevent Redis from becoming a bottleneck.
- **Failure Handling**: If Redis partitions, workers fallback to pure local rate limiting, ensuring the gateway remains available.
- **Performance Analysis**: Local limit check takes <15ns.
- **Configuration Example**:
  ```yaml
  services:
    user_service:
      rate_limit_max: 1000
  ```
- **Testing Strategy**: Simulated distributed load bursts using `k6` to measure drift and eventual consistency timing.

## 4. LOAD BALANCING
- **Detailed Design**: Implements Consistent Hashing in Rust (`load_balancer.rs`) to route sticky user sessions to the same upstream, minimizing upstream L1 cache misses.
- **Code Sketch**: Uses the `user_id` to compute a hash ring offset. Includes Exponential Moving Average (EMA) to prefer faster upstreams.
- **Scaling Strategy**: Fully decentralized. As upstream nodes are added/removed, the hash ring minimally disrupts assignments.
- **Failure Handling**: Detects upstream failure via NGINX status codes (5xx) and temporarily removes nodes from the ring.
- **Performance Analysis**: Hash computation and selection <20ns overhead.
- **Configuration Example**:
  ```yaml
  services:
    data_service:
      regional_upstreams:
        US:
          - address: "10.0.0.1:8080"
  ```
- **Testing Strategy**: Chaos testing upstream unreachability and observing the rebalancing distribution.

## 5. CIRCUIT BREAKERS
- **Detailed Design**: Lock-free sliding window tracking success/failure rates per upstream in L7 (`circuit_breaker.rs`).
- **Code Sketch**: Uses `AtomicU64` and bit-shifting to track failure percentages in a ring buffer. Trips to OPEN state when threshold exceeded, transitions to HALF-OPEN after a timeout.
- **Scaling Strategy**: Circuit breakers are per-worker to avoid global lock contention. At 10,000 nodes, overload cascades are prevented locally.
- **Failure Handling**: Protects fragile downstream services from catastrophic thundering herds.
- **Performance Analysis**: Zero-allocation state updates (<5ns).
- **Configuration Example**: (Hardcoded thresholds in `circuit_breaker.rs` -> extensible to Config)
- **Testing Strategy**: Inject 5xx responses artificially and verify fast-fail rejection times.

## 6. DATA RESIDENCY ENFORCEMENT
- **Detailed Design**: Hard constraints evaluated immediately after JWT parsing in `router.rs`.
- **Code Sketch**: Compares `jwt.home_region` to `GATEWAY_REGION` env variable.
- **Scaling Strategy**: Inherently scalable as it requires only a local string comparison.
- **Failure Handling**: Fail-closed (denies request if region doesn't match or is unidentifiable).
- **Performance Analysis**: <5ns string match.
- **Configuration Example**: `GATEWAY_REGION=EU`
- **Testing Strategy**: Send US-region tokens to EU gateway instances, verify 403 HTTP rejection.

## 7. CACHING
- **Detailed Design**: Multi-layer approach: L1 (per-worker memory) -> L2 (Redis) -> Upstream.
- **Code Sketch**: Implemented in `cache.rs`. Uses `moka` or a simple localized LRU for L1, failing over to `redis` via async background calls for non-hot-path.
- **Scaling Strategy**: Redis clusters handle global cache invalidation.
- **Failure Handling**: If Redis fails, L1 continues to serve stale data based on TTL.
- **Performance Analysis**: <100ns L1 hit, ~2ms L2 hit.
- **Configuration Example**: NGINX `proxy_cache` directives.
- **Testing Strategy**: Cache hit ratio measurement under varying key-space distributions.

## 8. OBSERVABILITY
- **Detailed Design**: Aggregated metrics exported to Prometheus. Generates a unique `X-Request-ID` for end-to-end tracing.
- **Code Sketch**: `telemetry.rs` uses `AtomicU64` counters to aggregate RPS and Latency histograms locally.
- **Scaling Strategy**: Pull-based Prometheus metrics scale naturally; no per-request push overhead.
- **Failure Handling**: If Prometheus is unreachable, metrics are kept in memory up to a capacity limit.
- **Performance Analysis**: Incrementing an atomic metric takes <2ns.
- **Configuration Example**: Endpoint `/metrics` exposed internally.
- **Testing Strategy**: Validate correct latency histogram binning under load.

## 9. SECURITY (WAF)
- **Detailed Design**: Lightweight URI, Header, and Body inspection in Rust (`waf.rs`) before routing.
- **Code Sketch**: Scans for known malicious signatures and excessively large payloads. Identifies IP addresses and maps to localized IP-based rate limits.
- **Scaling Strategy**: Operates fully in-memory, avoiding blocking regex engines.
- **Failure Handling**: Malformed or unparseable bodies are rejected immediately (fail-secure).
- **Performance Analysis**: ~200ns overhead depending on payload size.
- **Configuration Example**: Internal ModSec-style compiled rules.
- **Testing Strategy**: Send SQLi and XSS payloads to verify 403 rejection.

## 10. CONFIG MANAGEMENT
- **Detailed Design**: GitOps control plane that nodes poll with jittered intervals.
- **Code Sketch**: `config.rs` background thread uses `ureq` to fetch state, updating `ArcSwap` atomically.
- **Scaling Strategy**: Polling jitter prevents a 10,000 node thundering herd.
- **Failure Handling**: Retains last known good state indefinitely if Control Plane goes down.
- **Performance Analysis**: Zero-cost abstraction for read path (ArcSwap).
- **Configuration Example**: JSON payload from `control-plane`.
- **Testing Strategy**: Push malformed configs to Control Plane; verify workers ignore bad versions and maintain uptime.
