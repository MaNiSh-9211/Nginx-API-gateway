# ADR-0003 — Lock-free hot path (ArcSwap + atomics + thread-local)

**Status:** Accepted

## Context

The gateway runs one NGINX worker per core, each handling thousands of
concurrent connections on a single thread via the event loop. Any lock held on
the request path becomes a scalability bottleneck: under load, contention on a
shared `Mutex`/`RwLock` serializes workers and inflates tail latency
catastrophically (the classic "P99 cliff").

## Decision

The hot path takes **no locks**. Concurrency primitives by concern:

- **Config**: `ArcSwap<GatewayConfig>` — readers do an atomic pointer load
  (~2 ns) and hold an `Arc`; writers swap a whole new config atomically. Readers
  never block writers or each other.
- **Counters/gauges** (in-flight, metrics, rate-limit buckets, circuit-breaker
  state): plain `Atomic*` with `compare_exchange`/`fetch_add`.
- **Per-worker caches** (JWT LRU, upstream EMA stats): `thread_local!` — zero
  sharing, zero contention, no atomics at all.

## Alternatives considered

- **`Mutex`/`RwLock` around shared state.** Simple, but every reader contends.
  An `RwLock` still bounces a cache line and starves under write bursts.
  Rejected for the hot path (a `Mutex` *is* used in the control plane, where
  writes are rare and human-triggered — see ADR-0011).
- **`DashMap`/sharded maps for per-token state.** Lower contention than one lock,
  but still atomic coordination across workers for data that is naturally
  worker-local (a cached token only needs to be fast on *this* worker).
  Thread-local LRU is strictly cheaper.
- **Crossbeam epoch / RCU by hand.** `ArcSwap` already gives us the RCU read
  pattern with a clean, audited API; rolling our own adds risk for no gain.

## Consequences

- Reads scale linearly with cores; no shared-lock cliff.
- Config updates are atomic and wait-free for readers (zero-downtime swaps).
- Cost: per-worker caches mean state is duplicated across workers (e.g. a JWT
  validated on worker A is re-validated once on worker B) and cache invalidation
  is per-worker/TTL-based, not instant. This is an acceptable trade for
  contention-free reads (mitigated by short token TTLs and Redis revocation,
  ADR-0005).
- Truly global counters that must be exact across workers use shared memory
  instead of per-worker atomics (ADR-0004).
