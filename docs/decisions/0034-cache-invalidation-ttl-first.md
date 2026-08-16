# ADR-0034 — Cache invalidation: TTL-first, no global purge (v1)

**Status:** Accepted

## Context

[ADR-0017](0017-multi-layer-caching.md) established L2 `proxy_cache` for public
routes and an optional L1 thread-local cache in Rust. Cached responses become
wrong when upstream data changes (user profile update, inventory decrement).

Options for invalidation:

- **TTL only** — entries expire naturally
- **Event-driven global purge** — Redis pub/sub or control-plane webhook tells
  all gateway pods/workers to drop keys
- **Cache key versioning** — bump a version prefix on config change

## Decision

**TTL-first invalidation for v1.** No global purge bus.

| Layer | Invalidation | TTL |
|-------|--------------|-----|
| L2 `proxy_cache` | `proxy_cache_valid 200 30s`; `inactive=60s` | 30 s for 200 responses |
| L1 Rust (optional) | Per-entry `expires_at`; default 30 s | Configurable per `l1_set` |
| Authenticated traffic | **Not cached** (L2 bypass + no L1 on hot path) | N/A |

Rationale:

- Public, cacheable GETs are typically **eventually consistent** at 30 s (CDN
  semantics). Wrong-user risk is eliminated by not caching authenticated routes.
- A global purge system (Redis `PUBLISH gateway:cache:invalidate`, sidecar
  hook on `POST /config`) adds fleet-wide coordination and failure modes for
  marginal gain when TTLs are short.
- Config pushes already hot-swap routing in ~5 s (ADR-0012); cache entries for
  **old URL shapes** expire within one TTL window.

**When to add global purge:** catalog prices that must flip in &lt;1 s, or
compliance-driven immediate revocation of cached public content. Implement as
Redis pub/sub + NGINX `proxy_cache_purge` (commercial) or shorten TTL.

## Alternatives considered

- **Redis pub/sub invalidation now.** Correct but couples cache to Redis
  availability for correctness; rejected for v1.
- **Purge on every config push.** Would flush all L2 entries on any config
  change (including rate-limit tweaks) — too blunt.
- **No caching.** Rejected ([ADR-0017](0017-multi-layer-caching.md)).

## Consequences

- Simple, predictable semantics; no invalidation infrastructure to operate.
- Operators accept up to ~30 s staleness on public cached GETs.
- L1 remains unit-tested but **not on the hot path** until body-capture in
  `body_filter_by_lua` is justified by profiling.

## Related

- [ADR-0017 — Multi-layer caching](0017-multi-layer-caching.md)
- [docs/PERFORMANCE.md](../PERFORMANCE.md)
