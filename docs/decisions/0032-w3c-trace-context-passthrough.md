# ADR-0032 — W3C Trace Context passthrough (`traceparent`)

**Status:** Accepted

## Context

[ADR-0021](0021-request-correlation-ids.md) established **server-generated**
`X-Request-ID` for log correlation. Modern observability stacks (OpenTelemetry,
Jaeger, Datadog, Honeycomb) use the **W3C Trace Context** standard
(`traceparent` / `tracestate` headers) for distributed tracing across services.

We need both:

- A gateway-owned ID for support tickets and JSON access logs
- Compatibility with clients and meshes that already emit `traceparent`

## Decision

**Dual-header strategy:**

| Header | Source | Purpose |
|--------|--------|---------|
| `X-Request-ID` | **Generated** by Rust on every request | Log correlation, support, Prometheus-adjacent debugging |
| `traceparent` | **Passthrough** when client sends it | Join existing distributed traces |

Implementation (`gateway.lua`):

```lua
ngx.req.set_header("X-Request-ID", req_id)   -- always gateway-generated
if var.http_traceparent ~= "" then
    ngx.req.set_header("traceparent", traceparent)  -- forward unchanged
end
```

We do **not** parse or validate `traceparent` on the hot path — that would add
microseconds per request. OTel SDKs in upstreams parse it. Full OTel
instrumentation at the gateway edge is optional via `platform/monitoring/otel/` (ADR-0015).

## Alternatives considered

- **Replace X-Request-ID with traceparent only.** Breaks simple log grep and
  clients that do not use W3C tracing; rejected.
- **Parse traceparent and merge spans in Rust.** Correct for a native OTel
  exporter but adds hot-path cost; deferred to OTel collector sidecar pattern.
- **Trust client X-Request-ID.** Forgable/collidable (ADR-0021); rejected.

## Consequences

- Clients with OTel instrumentation keep trace continuity through the gateway.
- Gateway logs use `X-Request-ID`; APM tools use `traceparent` — operators map
  between them via timestamp + path when needed.
- `tracestate` is not forwarded yet (vendor-specific; add if required).

## Related

- [ADR-0021 — X-Request-ID](0021-request-correlation-ids.md)
- [ADR-0015 — Observability](0015-observability-prometheus-pull.md)
- [platform/monitoring/otel/otel-collector.yml](../../platform/monitoring/otel/otel-collector.yml)
