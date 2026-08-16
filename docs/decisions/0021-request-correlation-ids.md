# ADR-0021 — Request correlation IDs (X-Request-ID)

**Status:** Accepted

## Context

In a distributed system, tracing a single client request through the gateway,
across upstreams, and into logs requires a **stable, unique identifier** per
request. Without it, debugging production incidents (which user hit which
upstream, what was the latency) is guesswork.

Options:
- Generate at the edge (gateway)
- Trust client-provided `X-Request-ID` (or `traceparent`)
- Rely on NGINX's `$request_id` (random per request, not propagated to upstream)

## Decision

The gateway **generates** an `X-Request-ID` on every request in Rust
(`process_request`), using:

```
{worker_pid:08x}{counter:016x}
```

- Zero allocation (stack buffer + `write!` macro)
- Unique per worker process + monotonic counter
- Set as response header and forwarded upstream via `proxy_set_header`

Structured JSON access logs include timing and upstream; operators correlate via
`X-Request-ID`. OpenTelemetry tail sampling (ADR-0015) can use the same ID when
full distributed tracing is enabled.

## Alternatives considered

- **Trust client `X-Request-ID`.** Convenient for clients that already generate
  IDs, but attackers can forge or collide IDs, and empty/malformed values need
  validation. We generate server-side for integrity. W3C `traceparent` is
  forwarded unchanged when present — [ADR-0032](0032-w3c-trace-context-passthrough.md).
- **NGINX `$request_id`.** Built-in but not passed through our Rust hot path or
  upstream headers without extra config. Rust generation keeps ID creation in the
  same place as the rest of the hot path.
- **UUID v4.** Cryptographically random, but requires an RNG call (~hundreds of
  ns) and allocation. Our format is sufficient for correlation, not security.

## Consequences

- Every request (including 4xx/5xx rejects) gets an `X-Request-ID` in the
  response, making support and incident response tractable.
- Upstreams receive the ID and can include it in their own logs.
- Cost: ~5 ns per request for formatting; negligible vs WAF/auth.
