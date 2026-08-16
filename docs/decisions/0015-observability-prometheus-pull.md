# ADR-0015 — Observability: Prometheus pull + structured logs + OTel

**Status:** Accepted

## Context

We cannot operate a gateway we cannot see. We need low-overhead metrics, useful
logs, and request tracing — without the telemetry path itself becoming a hot-path
cost or a source of back-pressure on the app.

## Decision

Three complementary signals:

- **Metrics — Prometheus pull.** The Rust extension keeps counters/histograms in
  shared memory (ADR-0004) and renders them on demand at `GET /metrics`
  (`get_metrics_string`). Prometheus **scrapes** the gateway and control plane.
  Requests/latency histogram, 401/429/5xx, in-flight gauge, WAF blocks, and
  circuit-breaker state are exposed; alert rules live in
  `platform/monitoring/prometheus/rules/`. The `/metrics` endpoint is restricted to internal
  networks.
- **Logs — structured JSON access logs** (`log_format json_combined`) with ts,
  ip, method, uri, status, bytes, request/upstream time, region, UA — ready for
  ingestion/aggregation. A per-request `X-Request-ID` is generated in Rust and
  propagated upstream for correlation.
- **Tracing — OpenTelemetry** collector config (`platform/monitoring/otel/`) with tail
  sampling for export to a tracing backend.

## Alternatives considered

- **Push metrics (statsd / push to control plane).** The codebase originally
  pushed telemetry; we moved to **pull** because Prometheus pull gives free
  liveness (a down target is visible), no per-node push fan-in to manage, and
  decouples metric collection from the app's request loop. The control-plane
  `POST /telemetry` ingest remains for ad-hoc aggregation, but Prometheus is the
  system of record.
- **Logs only (no metrics).** Logs are high-cardinality and expensive to
  aggregate for real-time alerting; cheap pre-aggregated counters are the right
  tool for SLOs/alerts. We keep both.
- **Always-on full tracing.** Too expensive at gateway volume; tail sampling
  keeps the interesting traces (errors/slow) without tracing every request.

## Consequences

- Cheap, scrape-based metrics with built-in liveness; correlatable structured
  logs; sampled traces.
- Telemetry recording is off the critical decision (done in the `log` phase) and
  uses lock-free shared memory, so it does not slow request admission.
- Cost: pull requires network reachability from Prometheus to each target and
  metric endpoints must be access-controlled (done). Histogram bucket choice is a
  fixed trade-off between resolution and series cardinality.
