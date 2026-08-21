//! OpenTelemetry → Grafana Cloud (LGTM) bootstrap for the control plane.
//!
//! When `OTEL_EXPORTER_OTLP_ENDPOINT` is set and non-empty, exports:
//!   - traces  → Tempo (`{endpoint}/v1/traces`)
//!   - metrics → Mimir (`{endpoint}/v1/metrics`)
//!   - logs    → Loki   (`{endpoint}/v1/logs`)
//!
//! When the endpoint is unset, logging degrades to console-only via
//! `tracing-subscriber` + the `log` → `tracing` bridge (replacing env_logger).
//!
//! Headers (e.g. `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20...`) are
//! parsed from the environment by the OTLP exporters themselves (which URL-decode
//! `%XX` sequences), so no manual header handling is needed here.

use actix_web::body::MessageBody;
use actix_web::dev::{Service, ServiceRequest, ServiceResponse, Transform};
use actix_web::error::Error as ActixError;
use opentelemetry::metrics::{Counter, Gauge, Histogram};
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::Instrument;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// The `opentelemetry` crate re-exports `Resource` only as a type; the value
/// constructor is `resource_from_attributes`.
use opentelemetry_sdk::Resource;

use crate::redis_cb;

// ── Env configuration ─────────────────────────────────────────────────────────

fn otlp_endpoint() -> Option<String> {
    match std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT") {
        Ok(v) if !v.trim().is_empty() => Some(v.trim_end_matches('/').to_string()),
        _ => None,
    }
}

fn service_name() -> String {
    std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| "gateway-control-plane".to_string())
}

/// True when OTLP telemetry export is enabled via environment.
pub fn enabled() -> bool {
    otlp_endpoint().is_some()
}

// ── Lifecycle guard ───────────────────────────────────────────────────────────

static SHUT_DOWN: AtomicBool = AtomicBool::new(false);

/// Owns the SDK providers. Held for the process lifetime; dropping it (or
/// calling [`Telemetry::shutdown`]) flushes all pending telemetry.
pub struct Telemetry {
    _tracer_provider: Option<opentelemetry_sdk::trace::SdkTracerProvider>,
    _meter_provider: Option<opentelemetry_sdk::metrics::SdkMeterProvider>,
    _logger_provider: Option<opentelemetry_sdk::logs::SdkLoggerProvider>,
}

impl Telemetry {
    pub fn shutdown(&mut self) {
        if SHUT_DOWN.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(p) = self._meter_provider.take() {
            let _ = p.shutdown();
        }
        if let Some(p) = self._tracer_provider.take() {
            let _ = p.shutdown();
        }
        if let Some(p) = self._logger_provider.take() {
            let _ = p.shutdown();
        }
    }
}

impl Drop for Telemetry {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

/// Install the tracing subscriber (console always; OTel layers when enabled)
/// and, if enabled, the global OTel providers. Must be called exactly once,
/// from the process entry point.
pub fn init() -> Telemetry {
let resource = Resource::builder_empty()
        .with_attribute(KeyValue::new("service.name", service_name()))
        .with_attribute(KeyValue::new("service.namespace", "nginx-rust-api-gateway"))
        .build();
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let mut telemetry = Telemetry {
        _tracer_provider: None,
        _meter_provider: None,
        _logger_provider: None,
    };

    if let Some(base) = otlp_endpoint() {
// Traces → Tempo
        let span_exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_endpoint(format!("{base}/v1/traces"))
            .with_timeout(Duration::from_secs(10))
            .build();
        // If the exporter can't be built we still install a tracer provider
        // (with no exporter → spans are dropped) so downstream code keeps a
        // uniform `SdkTracer` type.
        let tracer_provider = match span_exporter {
            Ok(exporter) => opentelemetry_sdk::trace::SdkTracerProvider::builder()
                .with_batch_exporter(exporter)
                .with_resource(resource.clone())
                .build(),
            Err(e) => {
                eprintln!("[otlp] trace exporter init failed, traces disabled: {e}");
                opentelemetry_sdk::trace::SdkTracerProvider::builder()
                    .with_resource(resource.clone())
                    .build()
            }
        };
        opentelemetry::global::set_tracer_provider(tracer_provider.clone());

        // Metrics → Mimir (15s interval — Mimir rejects out-of-order samples,
        // so export cadence must stay well inside its out-of-order window).
        let metric_exporter = opentelemetry_otlp::MetricExporter::builder()
            .with_http()
            .with_endpoint(format!("{base}/v1/metrics"))
            .with_timeout(Duration::from_secs(10))
            .build();
        let meter_provider = match metric_exporter {
            Ok(exporter) => {
                let reader = opentelemetry_sdk::metrics::PeriodicReader::builder(exporter)
                    .with_interval(Duration::from_secs(15))
                    .build();
                let p = opentelemetry_sdk::metrics::SdkMeterProvider::builder()
                    .with_reader(reader)
                    .with_resource(resource.clone())
                    .build();
                opentelemetry::global::set_meter_provider(p.clone());
                Some(p)
            }
            Err(e) => {
                eprintln!("[otlp] metric exporter init failed, metrics disabled: {e}");
                None
            }
        };

        // Logs → Loki
        let log_exporter = opentelemetry_otlp::LogExporter::builder()
            .with_http()
            .with_endpoint(format!("{base}/v1/logs"))
            .with_timeout(Duration::from_secs(10))
            .build();
        let logger_provider = match log_exporter {
            Ok(exporter) => {
                let p = opentelemetry_sdk::logs::SdkLoggerProvider::builder()
                    .with_batch_exporter(exporter)
                    .with_resource(resource)
                    .build();
                Some(p)
            }
            Err(e) => {
                eprintln!("[otlp] log exporter init failed, logs disabled: {e}");
                None
            }
        };

// Console output stays on — Grafana Cloud should not be the only sink.
        let log_layer = logger_provider
            .as_ref()
            .map(opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge::new);
        let trace_layer = Some(
            tracing_opentelemetry::layer().with_tracer(tracer_provider.tracer("control-plane")),
        );

        tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout))
            .with(log_layer)
            .with(trace_layer)
            .init();

        telemetry._tracer_provider = Some(tracer_provider);
        telemetry._meter_provider = meter_provider;
        telemetry._logger_provider = logger_provider;

        // Periodic circuit-breaker metric recording on a background thread.
        std::thread::Builder::new()
            .name("otlp-metrics".into())
            .spawn(metric_recorder_loop)
            .ok();
    } else {
        // Console-only logging via tracing (replaces env_logger).
        tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout))
            .init();
    }

    // Bridge existing `log::*` macros into tracing so they reach both the
    // console layer and (when enabled) Loki via the appender layer.
    let _ = tracing_log::LogTracer::init();

    telemetry
}

// ── Circuit-breaker metric recorder ───────────────────────────────────────────

fn metric_recorder_loop() {
    let started = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(10));
        record_circuit_metrics();
        let _ = started; // uptime handled by record_circuit_metrics
    }
}

// ── Metrics ───────────────────────────────────────────────────────────────────

struct Metrics {
    // Gauges (redis circuit state / latency percentiles)
    state: Gauge<u64>,
    inflight: Gauge<i64>,
    p50: Gauge<u64>,
    p95: Gauge<u64>,
    p99: Gauge<u64>,
    error_rate: Gauge<f64>,
    uptime: Gauge<u64>,
    // Counters — deltas are computed between polls (cumulative source counters)
    requests_total: Counter<u64>,
    success_total: Counter<u64>,
    errors_total: Counter<u64>,
    timeouts_total: Counter<u64>,
    circuit_open_total: Counter<u64>,
    circuit_half_open_total: Counter<u64>,
    circuit_rejected_total: Counter<u64>,
    // HTTP per-request instruments
    http_requests: Counter<u64>,
    http_duration_ms: Histogram<f64>,
    // Previous counter snapshots (for delta export)
    prev: Mutex<[u64; 7]>,
}

static METRICS: OnceLock<Metrics> = OnceLock::new();

fn metrics() -> &'static Metrics {
    METRICS.get_or_init(|| {
        let meter = opentelemetry::global::meter("control-plane");
        Metrics {
            state: meter.u64_gauge("controlplane.redis.circuit.state").build(),
            inflight: meter.i64_gauge("controlplane.redis.circuit.inflight").build(),
            p50: meter.u64_gauge("controlplane.redis.latency.p50_us").build(),
            p95: meter.u64_gauge("controlplane.redis.latency.p95_us").build(),
            p99: meter.u64_gauge("controlplane.redis.latency.p99_us").build(),
            error_rate: meter.f64_gauge("controlplane.redis.error_rate").build(),
            uptime: meter.u64_gauge("controlplane.uptime_seconds").build(),
            requests_total: meter.u64_counter("controlplane.redis.requests.total").build(),
            success_total: meter.u64_counter("controlplane.redis.success.total").build(),
            errors_total: meter.u64_counter("controlplane.redis.errors.total").build(),
            timeouts_total: meter.u64_counter("controlplane.redis.timeouts.total").build(),
            circuit_open_total: meter.u64_counter("controlplane.redis.circuit.open.total").build(),
            circuit_half_open_total: meter
                .u64_counter("controlplane.redis.circuit.half_open.total")
                .build(),
            circuit_rejected_total: meter
                .u64_counter("controlplane.redis.circuit.rejected.total")
                .build(),
            http_requests: meter.u64_counter("controlplane.http.requests").build(),
            http_duration_ms: meter.f64_histogram("controlplane.http.duration_ms").build(),
            prev: Mutex::new([0; 7]),
        }
    })
}

/// Snapshot current circuit-breaker counters into OTel, exporting deltas so the
/// cumulative prom counters map cleanly onto OTel monotonic counters.
pub fn record_circuit_metrics() {
    if !enabled() {
        return;
    }
    let cb = redis_cb::get_cb();
    let m = metrics();

    m.state.record(cb.state() as u64, &[]);
    m.inflight.record(cb.inflight_count(), &[]);
    m.p50.record(cb.p50_us(), &[]);
    m.p95.record(cb.p95_us(), &[]);
    m.p99.record(cb.p99_us(), &[]);
    m.error_rate.record(cb.error_rate(), &[]);
    let uptime = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    m.uptime.record(uptime, &[]);

    let now = [
        cb.redis_requests_total.load(Ordering::Relaxed),
        cb.redis_success_total.load(Ordering::Relaxed),
        cb.redis_errors_total.load(Ordering::Relaxed),
        cb.redis_timeouts_total.load(Ordering::Relaxed),
        cb.circuit_open_total.load(Ordering::Relaxed),
        cb.circuit_half_open_total.load(Ordering::Relaxed),
        cb.circuit_rejected_total.load(Ordering::Relaxed),
    ];
    let mut prev = m.prev.lock().unwrap();
    let counters: [&Counter<u64>; 7] = [
        &m.requests_total,
        &m.success_total,
        &m.errors_total,
        &m.timeouts_total,
        &m.circuit_open_total,
        &m.circuit_half_open_total,
        &m.circuit_rejected_total,
    ];
    for (i, (counter, p)) in counters.iter().zip(prev.iter_mut()).enumerate() {
        let v = now[i];
        if v >= *p {
            counter.add(v - *p, &[]);
        }
        *p = v;
    }
}

/// Record a completed HTTP request (count + duration histogram).
pub fn record_http_request(method: &str, path: &str, status: u16, latency: Duration) {
    if !enabled() {
        return;
    }
    let m = metrics();
    let attrs = [
        KeyValue::new("http.method", method.to_string()),
        KeyValue::new("http.route", path.to_string()),
        KeyValue::new("http.status_code", i64::from(status)),
    ];
    m.http_requests.add(1, &attrs);
    m.http_duration_ms.record(latency.as_secs_f64() * 1000.0, &attrs);
}

// ── Actix middleware — per-request span + HTTP metrics ────────────────────────

/// Wrap this middleware around the app to get a tracing span (→ Tempo) and
/// request count/duration metrics (→ Mimir) for every HTTP request.
pub struct OtelMetrics;

impl<S, B> Transform<S, ServiceRequest> for OtelMetrics
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = ActixError> + 'static,
    S::Future: 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<B>;
    type Error = ActixError;
    type Transform = OtelMetricsMiddleware<S>;
    type InitError = ();
    type Future = std::future::Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        std::future::ready(Ok(OtelMetricsMiddleware {
            service: Rc::new(service),
        }))
    }
}

pub struct OtelMetricsMiddleware<S> {
    service: Rc<S>,
}

impl<S, B> Service<ServiceRequest> for OtelMetricsMiddleware<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = ActixError> + 'static,
    S::Future: 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<B>;
    type Error = ActixError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>>>>;

    fn poll_ready(&self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.service.poll_ready(cx)
    }

    fn call(&self, req: ServiceRequest) -> Self::Future {
        let start = Instant::now();
        let method = req.method().as_str().to_string();
        let path = req.path().to_string();
        // ADR-0060: request id from gateway when present; never log IP/UA.
        let rid = req
            .request()
            .headers()
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("-")
            .to_string();
        let span = tracing::info_span!("http.request", method = %method, path = %path);
        let fut = self.service.call(req);
        Box::pin(
            async move {
                println!("── REQ {rid} {method} {path}");
                let res = fut.await;
                let status = res.as_ref().map(|r| r.status().as_u16()).unwrap_or(0);
                let ms = start.elapsed().as_millis();
                println!("└ END {rid} status={status} {ms}ms");
                if status >= 500 {
                    tracing::error!(status = %status, path = %path, "request failed");
                }
                record_http_request(&method, &path, status, start.elapsed());
                res
            }
            .instrument(span),
        )
    }
}
