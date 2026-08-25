//! OpenTelemetry → Grafana Cloud (LGTM) for the gateway-edge FFI extension.
//!
//! Constrained by the cdylib / `panic=abort` environment:
//!   * no OpenTelemetry SDK (SDK + OTLP exporters pull in a large dep tree and
//!     re-export the http client we deliberately removed)
//!   * hand-rolled OTLP/JSON exporter over `ureq` (rustls TLS — no system
//!     libssl) on a background thread spawned from `init_extension`
//!   * the request hot path (~300–600 ns) is never touched. The exporter thread
//!     samples the lock-free telemetry state every 10 s; per-request spans are
//!     pushed from `report_telemetry` (post-request log phase) through a bounded
//!     channel with `try_send` — O(1), lossy, never blocking.
//!
//! Every NGINX worker process runs its own exporter (the module is forked per
//! worker). redis circuit-breaker counters are per-process, so those series
//! carry a `gateway.worker_pid` attribute to keep them distinct in Mimir.
//! Shared-memory metrics are already cross-worker aggregates and are not
//! labelled.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::redis_cb;
use crate::telemetry;

const SCOPE: &str = "gateway-edge";
const SERVICE_NAME: &str = "gateway-edge";
const SERVICE_NAMESPACE: &str = "routiq";

struct SpanEvent {
    status:     i32,
    latency_us: u64,
    start_ns:   u128,
    end_ns:     u128,
}

static TRACE_TX: OnceLock<mpsc::SyncSender<SpanEvent>> = OnceLock::new();
static LOCAL_COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn endpoint() -> Option<String> {
    let base = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok()?;
    if base.is_empty() { return None; }
    Some(base.trim_end_matches('/').to_string())
}

fn auth_header() -> Option<String> {
    let raw = std::env::var("OTEL_EXPORTER_OTLP_HEADERS").ok()?;
    for part in raw.split(',') {
        let kv: Vec<&str> = part.splitn(2, '=').collect();
        if kv.len() == 2 && kv[0].trim().eq_ignore_ascii_case("authorization") {
            return Some(percent_decode(kv[1].trim()));
        }
    }
    None
}

/// Push a completed-request span for the OTLP exporter (call from
/// `report_telemetry`, i.e. the post-request log phase — never the hot path).
pub fn record_request(status: i32, latency_us: u64) {
    if let Some(tx) = TRACE_TX.get() {
        let end = now_ns();
        let start = end.saturating_sub(latency_us as u128 * 1_000);
        let ev = SpanEvent { status, latency_us, start_ns: start, end_ns: end };
        let _ = tx.try_send(ev);
    }
}

/// Spawn the background exporter thread. No-op unless the OTLP env vars are set.
pub fn start() {
    let Some(base) = endpoint() else { return };
    let Some(auth) = auth_header() else { return };

    let agent = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("reqwest blocking client");

    let (tx, rx) = mpsc::sync_channel::<SpanEvent>(8192);
    let _ = TRACE_TX.set(tx);

    let _ = std::thread::Builder::new()
        .name("otlp-export".into())
        .spawn(move || {
            let agent = agent.clone();
            push_startup_log(&agent, &base, &auth);
            let mut prev_cb: [u64; 7] = [0; 7];
            let mut prev_shm: [u64; 6] = [0; 6];
            let mut last_state = redis_cb::get_cb().state();
            let started_ns = now_ns();
            loop {
                std::thread::sleep(Duration::from_secs(10));
                let ts = now_ns();
                export_metrics(
                    &agent, &base, &auth,
                    &mut prev_cb, &mut prev_shm,
                    ts, started_ns,
                );
                let cur_state = redis_cb::get_cb().state();
                if cur_state != last_state {
                    push_transition_log(&agent, &base, &auth, cur_state, last_state, ts);
                    last_state = cur_state;
                }
                drain_traces(&agent, &base, &auth, &rx);
            }
        })
        .ok();
}

fn post_json(agent: &reqwest::blocking::Client, base: &str, path: &str, auth: &str, body: &str) {
    let url = format!("{base}{path}");
    match agent
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", auth)
        .body(body.to_string())
        .send()
    {
        Ok(resp) => {
            let code = resp.status().as_u16();
            if code >= 300 {
                let text = resp.text().unwrap_or_default();
                eprintln!("[otlp] {path} status {code}: {text}");
            }
        }
        Err(e) => eprintln!("[otlp] {path} error: {e}"),
    }
}

fn resource_attrs() -> Vec<Value> {
    vec![
        json!({"key":"service.name","value":{"stringValue":SERVICE_NAME}}),
        json!({"key":"service.namespace","value":{"stringValue":SERVICE_NAMESPACE}}),
    ]
}

fn attrs(extra: &[(&str, &str)]) -> Vec<Value> {
    extra
        .iter()
        .map(|(k, v)| json!({"key": k, "value": {"stringValue": v}}))
        .collect()
}

fn push_gauge(out: &mut Vec<Value>, name: &str, extra: &[(&str, &str)], val: i64, ts: &str) {
    out.push(json!({
        "name": name,
        "gauge": {
            "dataPoints": [{ "timeUnixNano": ts, "asInt": val.to_string() }]
        }
    }));
    if !extra.is_empty() {
        if let Some(datapoint) = out.last_mut()
            .and_then(|m| m["gauge"]["dataPoints"].as_array_mut())
            .and_then(|dps| dps.first_mut())
        {
            datapoint["attributes"] = json!(attrs(extra));
        }
    }
}

fn push_gauge_double(out: &mut Vec<Value>, name: &str, val: f64, ts: &str) {
    out.push(json!({
        "name": name,
        "gauge": {
            "dataPoints": [{ "timeUnixNano": ts, "asDouble": val }]
        }
    }));
}

fn push_sum(out: &mut Vec<Value>, name: &str, extra: &[(&str, &str)], val: i64, start: &str, ts: &str) {
    out.push(json!({
        "name": name,
        "sum": {
            "isMonotonic": true,
            "aggregationTemporality": "AGGREGATION_TEMPORALITY_CUMULATIVE",
            "dataPoints": [{
                "startTimeUnixNano": start,
                "timeUnixNano": ts,
                "asInt": val.to_string()
            }]
        }
    }));
    if !extra.is_empty() {
        if let Some(datapoint) = out.last_mut()
            .and_then(|m| m["sum"]["dataPoints"].as_array_mut())
            .and_then(|dps| dps.first_mut())
        {
            datapoint["attributes"] = json!(attrs(extra));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn export_metrics(
    agent: &reqwest::blocking::Client,
    base: &str,
    auth: &str,
    prev_cb: &mut [u64; 7],
    prev_shm: &mut [u64; 6],
    ts_ns: u128,
    started_ns: u128,
) {
    let ts = ts_ns.to_string();
    let start = ts_ns.saturating_sub(10_000_000_000).to_string();
    let cb = redis_cb::get_cb();
    let pid = format!("{}", std::process::id());
    let pid_attr: &[(&str, &str)] = &[("gateway.worker_pid", &pid)];

    let mut metrics: Vec<Value> = Vec::with_capacity(22);

    push_gauge(&mut metrics, "gateway_redis_circuit_state", pid_attr, cb.state() as i64, &ts);
    push_gauge(&mut metrics, "gateway_redis_circuit_inflight", pid_attr, cb.inflight_count(), &ts);
    push_gauge(&mut metrics, "gateway_redis_latency_p50_us", pid_attr, cb.p50_us() as i64, &ts);
    push_gauge(&mut metrics, "gateway_redis_latency_p95_us", pid_attr, cb.p95_us() as i64, &ts);
    push_gauge(&mut metrics, "gateway_redis_latency_p99_us", pid_attr, cb.p99_us() as i64, &ts);
    push_gauge_double(&mut metrics, "gateway_redis_error_rate", cb.error_rate(), &ts);

    let cur_cb = [
        cb.redis_requests_total.load(Ordering::Relaxed),
        cb.redis_success_total.load(Ordering::Relaxed),
        cb.redis_errors_total.load(Ordering::Relaxed),
        cb.redis_timeouts_total.load(Ordering::Relaxed),
        cb.circuit_open_total.load(Ordering::Relaxed),
        cb.circuit_half_open_total.load(Ordering::Relaxed),
        cb.circuit_rejected_total.load(Ordering::Relaxed),
    ];
    const CB_NAMES: [&str; 7] = [
        "gateway_redis_requests_total",
        "gateway_redis_success_total",
        "gateway_redis_errors_total",
        "gateway_redis_timeouts_total",
        "gateway_redis_circuit_open_total",
        "gateway_redis_circuit_half_open_total",
        "gateway_redis_circuit_rejected_total",
    ];
    for (i, name) in CB_NAMES.iter().enumerate() {
        let delta = cur_cb[i].saturating_sub(prev_cb[i]);
        prev_cb[i] = cur_cb[i];
        push_sum(&mut metrics, name, pid_attr, delta as i64, &start, &ts);
    }

    let m = telemetry::snapshot();
    let cur_shm = [
        m.requests_total,
        m.requests_401,
        m.requests_429,
        m.requests_5xx,
        m.latency_us_sum,
        m.latency_us_count,
    ];
    const SHM_NAMES: [&str; 6] = [
        "gateway_http_requests_total",
        "gateway_http_requests_401_total",
        "gateway_http_requests_429_total",
        "gateway_http_requests_5xx_total",
        "gateway_latency_us_sum",
        "gateway_latency_us_count",
    ];
    for (i, name) in SHM_NAMES.iter().enumerate() {
        let delta = cur_shm[i].saturating_sub(prev_shm[i]);
        prev_shm[i] = cur_shm[i];
        push_sum(&mut metrics, name, &[], delta as i64, &start, &ts);
    }

    let uptime = ts_ns.saturating_sub(started_ns) / 1_000_000_000;
    push_gauge(&mut metrics, "gateway_uptime_seconds", &[], uptime as i64, &ts);

    let doc = json!({
        "resourceMetrics": [{
            "resource": { "attributes": resource_attrs() },
            "scopeMetrics": [{
                "scope": { "name": SCOPE },
                "metrics": metrics
            }]
        }]
    });
    post_json(agent, base, "/v1/metrics", auth, &doc.to_string());
}

fn state_name(s: u32) -> &'static str {
    match s {
        0 => "CLOSED",
        1 => "OPEN",
        _ => "HALF_OPEN",
    }
}

fn push_transition_log(agent: &reqwest::blocking::Client, base: &str, auth: &str, cur_state: u32, prev_state: u32, ts_ns: u128) {
    let (sev_num, sev_text, msg) = match cur_state {
        0 => (9, "INFO", "[gateway-edge] redis circuit CLOSED (recovered)"),
        1 => (13, "WARN", "[gateway-edge] redis circuit OPEN (tripped)"),
        _ => (13, "WARN", "[gateway-edge] redis circuit HALF_OPEN (probing)"),
    };
    let ts = ts_ns.to_string();
    let doc = json!({
        "resourceLogs": [{
            "resource": { "attributes": resource_attrs() },
            "scopeLogs": [{
                "scope": { "name": SCOPE },
                "logRecords": [{
                    "timeUnixNano": ts,
                    "observedTimeUnixNano": ts,
                    "severityNumber": sev_num,
                    "severityText": sev_text,
                    "body": { "stringValue": msg },
                    "attributes": [
                        {"key":"circuit.from","value":{"stringValue":state_name(prev_state)}},
                        {"key":"circuit.to","value":{"stringValue":state_name(cur_state)}}
                    ]
                }]
            }]
        }]
    });
    post_json(agent, base, "/v1/logs", auth, &doc.to_string());
}

fn push_startup_log(agent: &reqwest::blocking::Client, base: &str, auth: &str) {
    let ts = now_ns().to_string();
    let doc = json!({
        "resourceLogs": [{
            "resource": { "attributes": resource_attrs() },
            "scopeLogs": [{
                "scope": { "name": SCOPE },
                "logRecords": [{
                    "timeUnixNano": ts,
                    "observedTimeUnixNano": ts,
                    "severityNumber": 9,
                    "severityText": "INFO",
                    "body": { "stringValue": "[gateway-edge] OTLP exporter started" },
                    "attributes": [
                        {"key":"gateway.worker_pid","value":{"stringValue":format!("{}", std::process::id())}}
                    ]
                }]
            }]
        }]
    });
    post_json(agent, base, "/v1/logs", auth, &doc.to_string());
}

fn make_span(ev: SpanEvent) -> Value {
    let n = LOCAL_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id() as u64;
    let trace_id = format!("{:08x}{:016x}{:08x}", pid, n, (n.reverse_bits() & 0xFFFF_FFFF) as u32);
    let span_id = format!("{:016x}", (pid << 16) ^ n);
    let code = if ev.status >= 500 { 2 } else { 1 };
    json!({
        "traceId": trace_id,
        "spanId": span_id,
        "name": "gateway.request",
        "kind": 2,
        "startTimeUnixNano": ev.start_ns.to_string(),
        "endTimeUnixNano": ev.end_ns.to_string(),
        "attributes": [
            {"key":"http.status_code","value":{"intValue":ev.status.to_string()}},
            {"key":"http.duration_us","value":{"intValue":ev.latency_us.to_string()}}
        ],
        "status": { "code": code }
    })
}

fn drain_traces(agent: &reqwest::blocking::Client, base: &str, auth: &str, rx: &mpsc::Receiver<SpanEvent>) {
    let mut spans: Vec<Value> = Vec::with_capacity(64);
    while spans.len() < 128 {
        match rx.try_recv() {
            Ok(ev) => spans.push(make_span(ev)),
            Err(mpsc::TryRecvError::Empty) | Err(mpsc::TryRecvError::Disconnected) => break,
        }
    }
    if spans.is_empty() { return; }
    let doc = json!({
        "resourceSpans": [{
            "resource": { "attributes": resource_attrs() },
            "scopeSpans": [{
                "scope": { "name": SCOPE },
                "spans": spans
            }]
        }]
    });
    post_json(agent, base, "/v1/traces", auth, &doc.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live connectivity check against the configured OTLP endpoint.
    ///
    /// Opt-in: run with `cargo test -- --ignored --nocapture` and
    /// `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` set.
    /// Exercises two full export cycles (metrics, traces, startup log).
    #[test]
    #[ignore]
    fn live_otlp_export() {
        let _ = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
            .expect("OTEL_EXPORTER_OTLP_ENDPOINT must be set for the live OTLP test");
        let _ = std::env::var("OTEL_EXPORTER_OTLP_HEADERS")
            .expect("OTEL_EXPORTER_OTLP_HEADERS must be set for the live OTLP test");

        start();
        for i in 0..30 {
            record_request(if i % 3 == 0 { 500 } else { 200 }, 1_500 + i * 37);
        }
        std::thread::sleep(Duration::from_secs(25));
        eprintln!("[otlp] live test finished (2 export cycles attempted)");
    }
}
