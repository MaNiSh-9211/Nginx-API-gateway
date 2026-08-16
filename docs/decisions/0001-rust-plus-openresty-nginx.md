# ADR-0001 — Core stack: Rust hot path + OpenResty/NGINX

**Status:** Accepted

## Context

An API gateway sits on the critical path of *every* request. Its cost is paid by
100% of traffic, so the per-request budget is tiny (target: sub-millisecond
added latency at P99) while the feature surface is large (TLS, HTTP/1.1+HTTP/2,
connection pooling, buffering, caching, WAF, auth, routing, rate limiting). Two
problems must be solved well simultaneously:

1. **Battle-tested network edge** — TLS termination, slowloris protection,
   keepalive, HTTP parsing, proxying. Re-implementing these is a multi-year,
   bug-prone effort.
2. **Fast, safe custom logic** — auth, WAF, routing, limits with no GC pauses
   and no memory-safety footguns.

## Decision

Use **NGINX (via OpenResty)** for the network edge and **Rust** for all custom
hot-path logic, compiled to a shared library and called from NGINX.

- NGINX/OpenResty gives us a decade-hardened event loop, TLS stack, HTTP/2,
  `proxy_cache`, and connection management for free.
- Rust gives us C-class performance with memory safety and fearless
  concurrency, ideal for lock-free shared state (ADR-0003/0004).

## Alternatives considered

- **Envoy / Envoy + WASM filters.** Excellent proxy, but custom logic in WASM
  pays a sandboxing tax and a more awkward ABI; C++ filters are powerful but
  unsafe and slow to iterate. Operating Envoy's xDS is heavy for this scope.
- **Kong (OpenResty + Lua).** Same edge as us, but business logic in interpreted
  Lua is slower and less safe for crypto/parsing than Rust. We keep OpenResty
  but push logic into Rust.
- **Pure Rust (e.g. Pingora/Hyper-based).** Cloudflare's Pingora proves this is
  viable and is arguably the long-term ideal. We rejected it *for now* because
  reproducing NGINX's full edge feature set and operational maturity (config
  surface, `proxy_cache`, ecosystem) is a large undertaking; OpenResty lets us
  ship a complete edge immediately and still run Rust on the hot path. See
  ADR-0002 for the native-module variant we keep as a research track.
- **Go (e.g. custom net/http gateway).** Great ergonomics, but GC pauses are a
  poor fit for tight, predictable tail latency, and lock-free shared-memory
  tricks are harder to express safely.

## Consequences

- We inherit NGINX's robustness and a rich, declarative edge config.
- We get Rust performance/safety for the logic that differentiates us.
- Cost: a two-language system and an FFI boundary to manage (ADR-0002), plus a
  heavier build (compile Rust, package into OpenResty).
- The pure-Rust proxy remains an attractive future migration if/when the edge
  feature gap closes.
