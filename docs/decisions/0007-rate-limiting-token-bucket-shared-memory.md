# ADR-0007 — Rate limiting: shared-memory token bucket

**Status:** Accepted

## Context

Rate limiting protects upstreams and enforces fairness/quotas. It must be cheap
(hot path), consistent across workers on a node, and degrade gracefully. Keys are
per-user (authenticated) or per-IP (anonymous, handled in the WAF, ADR-0006).

## Decision

Use a **lock-free token-bucket / fixed-window counter in shared memory**
(ADR-0004), keyed by a hash of the user id (or IP). Each bucket packs a timestamp
and a count into a single `AtomicU64`, updated with `compare_exchange`:

- On each request: read the bucket; if its window is stale, reset to the current
  second with count 1; otherwise increment unless the per-window limit is hit.
- Limits come from the service's `rate_limit_max` in `GatewayConfig` (hot-swappable
  via ArcSwap, ADR-0011).
- ~15 ns per check, no locks, shared across all workers on the node.

## Alternatives considered

- **Redis-based limiting (INCR/Lua script).** Gives exact *fleet-wide* limits,
  but a network round trip per request is over budget and makes basic limiting
  fail when Redis is unavailable. Rejected for the hot path. (Redis remains
  available for cross-node concerns off the hot path.)
- **Sliding-window log / leaky bucket with timestamps.** More precise burst
  smoothing, but needs per-key storage and more work per request. The packed
  atomic window is a deliberate precision-for-speed trade; burst tolerance is
  tuned via window size and an optional burst multiplier.
- **Per-worker counters only.** Cheapest, but each worker would grant the full
  limit, multiplying the effective limit by the core count. Shared memory gives
  one node-wide budget.

## Consequences

- Extremely cheap, node-consistent limiting that keeps working if Redis is down.
- Limits are **per node**; fleet-wide limits are approximated by dividing quotas
  across nodes (horizontal scaling, ADR-0001/0004). For hard global quotas, a
  Redis/cell-based limiter can be layered for specific high-value keys.
- Fixed-window edges can allow a brief 2× burst across a boundary — acceptable
  for protection-oriented limiting; tighten the window if stricter smoothing is
  needed.
