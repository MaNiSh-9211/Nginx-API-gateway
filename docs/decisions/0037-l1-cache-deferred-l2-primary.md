# ADR-0037 — L1 Rust cache deferred; L2 NGINX cache is production path

**Status:** Accepted

## Context

ADR-0017 describes a two-tier cache: **L1** (thread-local in Rust, microsecond
lookups) and **L2** (`proxy_cache` in NGINX, shared across workers). L1 is
implemented in `services/gateway/edge/rust-ext/src/cache.rs` with unit tests, but wiring it
into `process_request` would short-circuit before `proxy_pass` — a different
semantic than NGINX caching (no automatic `Cache-Control`, `Vary`, or stale
handling).

## Decision

**Production caching is L2 only** (`gateway/gateway-locations.conf`):

- `proxy_cache` with keyed zones per route class
- **Skip cache** when `Authorization` is present (per-user responses must not
  leak across tenants)
- TTL-first invalidation (ADR-0034); no active purge API in v0.6

**L1 remains implemented but unwired** (`#![allow(dead_code)]`) as a documented
future optimization for **anonymous, cacheable GET** responses where we can
prove identical semantics to L2 (same key material, TTL, and vary rules).

## Alternatives considered

- **Wire L1 now for all GETs.** Risk of serving stale/wrong tenant data or
  diverging from NGINX cache headers; rejected until keying is proven identical.
- **Remove L1 code.** Loses tested foundation for a later perf win; kept with ADR.
- **Redis as L2.** Shared invalidation is powerful but adds RTT on every miss and
  operational dependency; NGINX disk/memory cache is zero-RTT at the edge.
- **CDN-only caching.** Good for static assets; API gateways still benefit from
  origin shielding at the edge node (L2).

## Consequences

- Simpler hot path; one source of cache truth (NGINX).
- Best latency for cache hits still excellent (kernel + NGINX, no Rust hop).
- Future L1 wiring requires an ADR update + E2E tests for auth-bypass and TTL.

## Related

- [ADR-0017](0017-multi-layer-caching.md)
- [ADR-0034](0034-cache-invalidation-ttl-first.md)
- [`../../services/gateway/edge/rust-ext/src/cache.rs`](../../services/gateway/edge/rust-ext/src/cache.rs)
