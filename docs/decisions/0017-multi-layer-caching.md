# ADR-0017 — Multi-layer caching (L1 thread-local + L2 proxy_cache)

**Status:** Accepted

## Context

Caching cuts latency and offloads upstreams, but a cache shared across workers
adds coordination cost, and an overly clever cache can serve stale or wrong data.
We want cheap hits without lock contention and without re-implementing HTTP cache
semantics.

## Decision

Two cache layers with distinct jobs:

- **L2 — NGINX `proxy_cache` (response cache).** The proven, HTTP-aware layer:
  `proxy_cache_path` (64 MB keys / 4 GB body), keyed by method+host+uri+args,
  with `proxy_cache_lock` (dogpile protection) and `proxy_cache_use_stale`
  (serve stale on upstream error/timeout — availability under failure). Cache
  status is surfaced via `X-Cache-Status`. **Authenticated requests bypass L2**
  (`proxy_no_cache` when `Authorization` is present) because the cache key does
  not include identity — caching them would return the wrong user's routed
  response.
- **L1 — per-worker thread-local response cache (Rust).** A contention-free
  (ADR-0003) hot cache for the very hottest keys, with its own key derivation
  (incl. user) and TTL. It is fully implemented and unit-tested; it is wired in
  conservatively and intended for the hottest, safely-cacheable paths.

## Alternatives considered

- **A single shared in-process cache (one map + lock).** Higher hit rate than
  per-worker, but reintroduces lock contention on the hot path; the per-worker L1
  trades a little duplication for zero contention, with L2 catching cross-worker
  reuse.
- **Redis as the response cache (L2).** Network hop per lookup and a hard
  dependency; NGINX's local disk/memory `proxy_cache` is faster and degrades
  gracefully. Redis here is reserved for revocation/coordination, not response
  bodies.
- **No caching.** Leaves easy latency/offload wins on the table.

## Consequences

- Hot responses are served locally and cheaply; upstreams are shielded
  (dogpile + stale-on-error).
- Two layers must be reasoned about together (correctness of what is cacheable);
  L1 is deliberately scoped to safe, hot keys.
- Cost: cache invalidation is TTL-based ([ADR-0034](0034-cache-invalidation-ttl-first.md));
  keep TTLs short for volatile public data. L1 is unit-tested but not on the
  hot path until profiling justifies body-capture wiring.
