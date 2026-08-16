# ADR-0009 — Load balancing: consistent hash + EMA latency

**Status:** Accepted

## Context

Within a region, a service has several upstreams. We want: cache/session
affinity (a given user tends to hit the same backend, improving upstream cache
hit rates), automatic avoidance of unhealthy or slow backends, and no locks.

## Decision

Per request, in Rust (`load_balancer::select_upstream`):

1. **Weighted consistent placement** — each upstream occupies `weight` slots on a
   virtual ring (minimum weight 1). `FxHash(user_id) % ring.len()` picks the
   primary slot, so traffic splits proportionally (e.g. weights 10:5 → ~67%:33%)
   while keeping per-user affinity.
2. **Health skip** — upstreams whose circuit is open (ADR-0008) are skipped;
   selection rotates to the next healthy candidate.
3. **Latency awareness** — a per-worker **EMA of response latency** (α=0.1,
   thread-local, ADR-0003) is tracked per upstream; if a healthy alternative is
   **>20% faster** than the affinity choice, prefer it. Cold upstreams (<10
   samples) are treated as unknown so they are not wrongly penalized or favored.

NGINX proxies to the chosen **`host:port` address** (not the logical upstream
name) via `proxy_pass http://$target_upstream` with the Docker/Cluster DNS
`resolver`, so backends are 100% config-driven and adding/removing one needs
**no NGINX reload**. Circuit-breaker and EMA keys use the same address string
that `proxy_pass` and telemetry see, so failure tracking stays aligned with the
actual backend contacted.

## Alternatives considered

- **Round-robin / least-connections (NGINX built-ins).** Simple and good for
  uniform stateless backends, but they break affinity (worse upstream cache hit
  rates) and least-conn needs shared connection counts. Our hash+EMA keeps
  affinity while still steering away from slow nodes.
- **`balancer_by_lua` + keepalive upstream pools.** This keeps upstream
  keepalive connections (a real throughput win) but `set_current_peer` needs
  resolved IPs (no hostnames) and adds a Lua balancer phase and DNS handling in
  Lua. We chose `proxy_pass` + `resolver` for correctness and simplicity in a
  service-discovery (DNS) environment; the keepalive-pool design is the
  documented optimization to adopt when upstream connection churn becomes the
  bottleneck.
- **Power-of-two-choices (P2C).** Excellent general-purpose algorithm; our
  hash-primary + EMA-override is a close cousin that additionally preserves
  affinity. P2C is a reasonable future swap if affinity matters less.

## Consequences

- Affinity for cache locality, automatic avoidance of slow/broken upstreams,
  fully dynamic backend topology, all lock-free.
- Cost: `proxy_pass` with a variable does not reuse an upstream keepalive pool,
  so we trade some connection reuse for operational simplicity and correct DNS
  behavior. EMA is per-worker (each worker learns independently), which is fine
  given many requests per worker.
