# ADR-0010 — Backpressure / admission control runs first

**Status:** Accepted

## Context

Under overload (traffic spike, slow upstreams), a gateway that keeps accepting
work collapses: queues grow, latency explodes, memory balloons, everything times
out. The cheapest request is one you reject *before* doing any work. We need a
hard ceiling on concurrent in-flight work and a way to shed load instantly.

## Decision

**Backpressure is the very first step of the hot path**, before WAF/auth/etc.:

- A process-wide `AtomicI64` in-flight gauge is incremented on admit and
  decremented exactly once on completion (`release_slot`, log phase).
- Admission compares against `global_max_concurrency` (from config, ArcSwap).
  Over the limit → immediate **503 + `Retry-After`** in ~5 ns, before any
  parsing, crypto, or upstream contact.
- It is **circuit-breaker-aware** (ADR-0008): when the global breaker is
  half-open, the limit tightens to ~10% (cautious probing); when open, all
  traffic is rejected.

The slot lifecycle is managed explicitly so it is released exactly once whether
the request was admitted (released after proxying) or rejected early (released
inside `process_request`). This avoids the double-release bug that would drive
the gauge negative.

## Alternatives considered

- **No admission control, rely on upstream/timeouts.** Lets overload propagate
  and amplify; tail latency and memory blow up. Rejected.
- **Queue requests and serve when capacity frees up.** Queues add latency and
  hide overload; under sustained load the queue is just deferred failure. Fail-
  fast with `Retry-After` is kinder to clients and the system.
- **Adaptive concurrency (e.g. Gradient/Vegas-style limit discovery).** A great
  enhancement — dynamically learn the limit from latency. We start with a
  configured ceiling (predictable, simple) and leave adaptive limits as a future
  upgrade layered on the same gauge.

## Consequences

- The system degrades predictably: it protects itself in nanoseconds and signals
  clients to back off.
- Composes with the breaker for graded shedding (full → 10% → 0%).
- Cost: a static ceiling must be sized to the node; too low wastes capacity, too
  high lets overload in. Tune from observed throughput/latency (ADR-0015/0020);
  consider adaptive limits later.
