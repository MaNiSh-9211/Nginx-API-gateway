# ADR-0026 — Structured JSON access logs

**Status:** Accepted

## Context

Operating a gateway fleet requires correlating edge logs with upstream traces,
metrics, and incident timelines. Plain-text NGINX `combined` logs are hard to
query in Loki/ELK/Datadog and do not carry gateway-specific fields (`region`,
`upstream`, request correlation ID).

## Decision

**JSON `access_log` format** (`json_combined` in `gateway/nginx.conf`) with
`escape=json` for safe embedding of user agents and URIs.

Fields emitted per request:

| Field | Source | Purpose |
|-------|--------|---------|
| `ts` | `$time_iso8601` | Sortable timestamp |
| `req_id` | `$gateway_request_id` | Correlates with `X-Request-ID` (ADR-0021) |
| `ip` | `$remote_addr` | Client after real-IP rewrite (ADR-0027) |
| `method`, `uri`, `status`, `bytes` | Standard | Traffic analysis |
| `rt` | `$request_time` | End-to-end gateway time |
| `upstream`, `upstream_rt` | Proxy vars | Backend diagnosis |
| `region` | `$target_region` | Residency / PoP debugging |
| `ua` | User-Agent | Bot / client classification |

`gateway_request_id` is set in `gateway.lua` from the Rust-generated ID so logs
match response headers even when the client did not send a correlation header.

Logs are buffered (`buffer=64k flush=5s`) to reduce syscall overhead under load.

## Alternatives considered

- **OpenTelemetry logs only.** Better for distributed traces, but many teams
  still ingest NGINX access logs; OTel is additive (see `platform/monitoring/otel/`).
- **Plain combined log + log shipper parsing.** Fragile regex; rejected.
- **Log every request body.** Security/privacy risk and I/O cost; rejected.

## Consequences

- Log volume is larger than combined format but trivially queryable.
- `req_id` ties access logs to application logs that echo `X-Request-ID`.
- Operators should ship `/var/log/nginx/access.log` to their log platform with
  JSON parsing disabled (already JSON).

## Related

- [ADR-0021 — Request correlation IDs](0021-request-correlation-ids.md)
- [ADR-0015 — Observability](0015-observability-prometheus-pull.md)
