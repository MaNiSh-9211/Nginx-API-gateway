# ADR-0048 — Circuit-breaker half-open CAS fix + strip spoofed identity headers

**Status:** Accepted

## Context

Two production-hardening issues surfaced during audit:

### 1. Circuit breaker stuck after cooldown

In `UpstreamCB::is_open()`, when state was `OPEN` and the cooldown elapsed, the
code used `compare_exchange(OPEN, HALF_OPEN).is_err()` as the return value. That
meant:

- CAS **succeeds** (this worker probes) → `is_open()` returns `false` ✓
- CAS **fails** because another worker already moved to `HALF_OPEN` →
  `is_open()` returns `true` ✗ — **all other workers block traffic during
  recovery**, defeating half-open probing.

Under multi-worker NGINX (the normal deployment), recovery could stall until
timeouts or manual intervention.

### 2. Client-supplied `X-User-Id` spoofing

ADR-0040 documents that upstreams receive gateway-injected identity headers.
`proxy_set_header` overwrites on the upstream leg, but clients could still send
`X-User-Id` / `X-Home-Region` on the **ingress** request. Relying only on
overwrite is fragile (logging, intermediate filters, future code paths).

## Decision

### Circuit breaker (ADR-0008 amendment)

On cooldown expiry, `is_open()` now returns:

```rust
match compare_exchange(OPEN, HALF_OPEN, ...) {
    Ok(_) => false,                      // this worker probes
    Err(current) => current != HALF_OPEN, // HALF_OPEN → allow; else block
}
```

`STATE_HALF_OPEN` is an explicit match arm (not a catch-all `_`).

Seven unit tests in `circuit_breaker.rs` lock the state machine transitions.

### Identity header stripping (ADR-0040 amendment)

At the start of `gateway.lua` `access()`, before Rust runs:

```lua
ngx.req.clear_header("X-User-Id")
ngx.req.clear_header("X-Home-Region")
```

Only post-auth values from JWT validation are set on the upstream leg.

E2E asserts: a request with `X-User-Id: attacker` and a valid JWT for
`alice` must echo `alice`, not `attacker`.

## Alternatives considered

- **Rely on `proxy_set_header` overwrite only.** Works today but fails closed
  poorly; explicit strip is zero-cost and obvious in code review.
- **Reject requests that carry `X-User-Id`.** Breaks legitimate proxies that
  forward headers; strip + re-set is the standard gateway pattern.
- **Distributed breaker with Redis.** Correct for multi-node shared state but
  adds RTT; mmap atomics remain per-node (ADR-0004).
- **Retry `is_open()` after failed CAS.** Extra atomic loads on hot path;
  inspecting `Err(current)` is sufficient.

## Consequences

- Multi-worker recovery probes work as designed.
- Backends can trust `X-User-Id` when the private network boundary is enforced
  ([ADR-0040](0040-identity-headers-to-upstream.md), [MTLS guide](../guides/MTLS.md)).
- E2E suite gains a spoofing regression test.

## Related

- [ADR-0008](0008-circuit-breaker.md) · [ADR-0040](0040-identity-headers-to-upstream.md)
- [`../../services/gateway/edge/rust-ext/src/circuit_breaker.rs`](../../services/gateway/edge/rust-ext/src/circuit_breaker.rs)
- [`../../services/gateway/edge/lua/gateway.lua`](../../services/gateway/edge/lua/gateway.lua)
