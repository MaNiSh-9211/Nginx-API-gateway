//! Telemetry — Lock-free Cross-Process Shared Memory Metrics
//!
//! Metrics exposed to Prometheus:
//!   gateway_requests_total          counter
//!   gateway_requests_401_total      counter
//!   gateway_requests_429_total      counter
//!   gateway_requests_5xx_total      counter
//!   gateway_latency_us_sum          counter
//!   gateway_latency_us_count        counter
//!   gateway_in_flight               gauge
//!   gateway_waf_blocks_total        counter
//!   gateway_cache_hits_total        counter
//!   gateway_cache_misses_total      counter

use std::sync::atomic::{AtomicU64, Ordering};
use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::sync::OnceLock;

const HIST_BUCKETS_US: &[u64] = &[100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const NUM_BUCKETS: usize = 7;

#[repr(C)]
pub struct Metrics {
    pub requests_total:   AtomicU64,
    pub requests_401:     AtomicU64,
    pub requests_429:     AtomicU64,
    pub requests_5xx:     AtomicU64,
    pub latency_us_sum:   AtomicU64,
    pub latency_us_count: AtomicU64,
    pub latency_buckets:  [AtomicU64; NUM_BUCKETS],
}

static SHM_PTR: OnceLock<usize> = OnceLock::new();

fn init_shm() -> usize {
    let path = std::env::temp_dir().join("gateway_telemetry.shm");
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(&path).unwrap();

    file.set_len(std::mem::size_of::<Metrics>() as u64).unwrap();

    let mmap = unsafe { MmapMut::map_mut(&file).unwrap() };
    let ptr = mmap.as_ptr() as usize;
    std::mem::forget(mmap);
    ptr
}

fn get_metrics() -> &'static Metrics {
    let ptr = *SHM_PTR.get_or_init(init_shm) as *const Metrics;
    unsafe { &*ptr }
}

pub fn start_telemetry_sync() {
    // HTTP Push removed. Prometheus will scrape /metrics instead.
}

pub struct TelemetrySnapshot {
    pub requests_total:   u64,
    pub requests_401:     u64,
    pub requests_429:     u64,
    pub requests_5xx:     u64,
    pub latency_us_sum:   u64,
    pub latency_us_count: u64,
}

pub fn snapshot() -> TelemetrySnapshot {
    let m = get_metrics();
    TelemetrySnapshot {
        requests_total:   m.requests_total.load(Ordering::Relaxed),
        requests_401:     m.requests_401.load(Ordering::Relaxed),
        requests_429:     m.requests_429.load(Ordering::Relaxed),
        requests_5xx:     m.requests_5xx.load(Ordering::Relaxed),
        latency_us_sum:   m.latency_us_sum.load(Ordering::Relaxed),
        latency_us_count: m.latency_us_count.load(Ordering::Relaxed),
    }
}

pub fn record_request(status: i32, latency_us: usize) {
    let m = get_metrics();
    let lat = latency_us as u64;

    m.requests_total.fetch_add(1, Ordering::Relaxed);
    m.latency_us_sum.fetch_add(lat, Ordering::Relaxed);
    m.latency_us_count.fetch_add(1, Ordering::Relaxed);

    for (i, &bound) in HIST_BUCKETS_US.iter().enumerate() {
        if lat <= bound {
            m.latency_buckets[i].fetch_add(1, Ordering::Relaxed);
        }
    }

    match status {
        401       => { m.requests_401.fetch_add(1, Ordering::Relaxed); }
        429       => { m.requests_429.fetch_add(1, Ordering::Relaxed); }
        500..=599 => { m.requests_5xx.fetch_add(1, Ordering::Relaxed); }
        _ => {}
    }
}

pub fn prometheus_text() -> String {
    use crate::backpressure::current_in_flight;
    use crate::load_balancing::global_state;
    use crate::config::GLOBAL_CONFIG;
    use crate::waf::waf_blocks_total;
    use crate::rate_limit::{RL_REDIS_SYNCS_OK, RL_REDIS_SYNCS_ERR, RL_SYNC_THREAD_RESTARTS};
    use crate::redis_cb::get_cb;

    let m = get_metrics();
    let cfg = GLOBAL_CONFIG.load();

    let reqs   = m.requests_total.load(Ordering::Relaxed);
    let r401   = m.requests_401.load(Ordering::Relaxed);
    let r429   = m.requests_429.load(Ordering::Relaxed);
    let r5xx   = m.requests_5xx.load(Ordering::Relaxed);
    let lat_sum = m.latency_us_sum.load(Ordering::Relaxed);
    let lat_cnt = m.latency_us_count.load(Ordering::Relaxed);
    let flight = current_in_flight();
    let cb     = global_state();
    let waf    = waf_blocks_total();
    let max_conc = cfg.global_max_concurrency as i64;
    let ready  = if crate::config::is_config_ready() { 1 } else { 0 };
    let cache_hits = crate::cache::CACHE_HITS.load(Ordering::Relaxed);
    let cache_miss = crate::cache::CACHE_MISSES.load(Ordering::Relaxed);
    let rl_syncs_ok  = RL_REDIS_SYNCS_OK.load(Ordering::Relaxed);
    let rl_syncs_err = RL_REDIS_SYNCS_ERR.load(Ordering::Relaxed);
    let rl_restarts  = RL_SYNC_THREAD_RESTARTS.load(Ordering::Relaxed);
    let rl_redis_enabled: u8 = if crate::rate_limit::rl_redis_enabled_pub() { 1 } else { 0 };

    // Circuit breaker metrics
    let cb_inst = get_cb();
    let redis_req_total   = cb_inst.redis_requests_total.load(Ordering::Relaxed);
    let redis_ok_total    = cb_inst.redis_success_total.load(Ordering::Relaxed);
    let redis_err_total   = cb_inst.redis_errors_total.load(Ordering::Relaxed);
    let redis_to_total    = cb_inst.redis_timeouts_total.load(Ordering::Relaxed);
    let cb_open_total     = cb_inst.circuit_open_total.load(Ordering::Relaxed);
    let cb_half_open_total = cb_inst.circuit_half_open_total.load(Ordering::Relaxed);
    let cb_rejected_total = cb_inst.circuit_rejected_total.load(Ordering::Relaxed);
    let cb_state_val      = cb_inst.state();   // 0=CLOSED, 1=OPEN, 2=HALF_OPEN
    let cb_inflight       = cb_inst.inflight_count();
    let cb_p50_us         = cb_inst.p50_us();
    let cb_p95_us         = cb_inst.p95_us();
    let cb_p99_us         = cb_inst.p99_us();
    let cb_err_rate       = cb_inst.error_rate();

    let mut out = String::with_capacity(2_048);

    out.push_str(&format!(
        "# HELP gateway_requests_total Total requests processed\n\
         # TYPE gateway_requests_total counter\n\
         gateway_requests_total {reqs}\n\
         # HELP gateway_requests_401_total Unauthorized requests\n\
         # TYPE gateway_requests_401_total counter\n\
         gateway_requests_401_total {r401}\n\
         # HELP gateway_requests_429_total Rate-limited requests\n\
         # TYPE gateway_requests_429_total counter\n\
         gateway_requests_429_total {r429}\n\
         # HELP gateway_requests_5xx_total Server error responses\n\
         # TYPE gateway_requests_5xx_total counter\n\
         gateway_requests_5xx_total {r5xx}\n"
    ));

    out.push_str(
        "# HELP gateway_latency_us Latency histogram in microseconds\n\
         # TYPE gateway_latency_us histogram\n",
    );
    for (i, &bound) in HIST_BUCKETS_US.iter().enumerate() {
        let count = m.latency_buckets[i].load(Ordering::Relaxed);
        out.push_str(&format!("gateway_latency_us_bucket{{le=\"{bound}\"}} {count}\n"));
    }
    out.push_str(&format!(
        "gateway_latency_us_bucket{{le=\"+Inf\"}} {lat_cnt}\n\
         gateway_latency_us_sum {lat_sum}\n\
         gateway_latency_us_count {lat_cnt}\n"
    ));

    out.push_str(&format!(
        "# HELP gateway_in_flight Current in-flight requests\n\
         # TYPE gateway_in_flight gauge\n\
         gateway_in_flight {flight}\n\
         # HELP gateway_max_concurrency Configured concurrency ceiling\n\
         # TYPE gateway_max_concurrency gauge\n\
         gateway_max_concurrency {max_conc}\n\
         # HELP gateway_waf_blocks_total Requests blocked by the WAF\n\
         # TYPE gateway_waf_blocks_total counter\n\
         gateway_waf_blocks_total {waf}\n\
         # HELP gateway_config_ready 1 when a non-default config snapshot is loaded\n\
         # TYPE gateway_config_ready gauge\n\
         gateway_config_ready {ready}\n\
         # HELP gateway_cache_hits_total L1 cache hits\n\
         # TYPE gateway_cache_hits_total counter\n\
         gateway_cache_hits_total {cache_hits}\n\
         # HELP gateway_cache_misses_total L1 cache misses\n\
         # TYPE gateway_cache_misses_total counter\n\
         gateway_cache_misses_total {cache_miss}\n\
         # HELP gateway_circuit_breaker_state Global CB state (0=closed,1=open,2=half-open)\n\
         # TYPE gateway_circuit_breaker_state gauge\n\
         gateway_circuit_breaker_state {cb}\n\
         # HELP gateway_up Gateway process is up\n\
         # TYPE gateway_up gauge\n\
         gateway_up 1\n\
         # HELP gateway_rate_limit_redis_syncs_total Successful fleet-wide RL Redis syncs\n\
         # TYPE gateway_rate_limit_redis_syncs_total counter\n\
         gateway_rate_limit_redis_syncs_total {rl_syncs_ok}\n\
         # HELP gateway_rate_limit_redis_sync_errors_total Failed RL Redis syncs (fail-open)\n\
         # TYPE gateway_rate_limit_redis_sync_errors_total counter\n\
         gateway_rate_limit_redis_sync_errors_total {rl_syncs_err}\n\
         # HELP gateway_rate_limit_sync_thread_restarts_total Times RL sync thread restarted\n\
         # TYPE gateway_rate_limit_sync_thread_restarts_total counter\n\
         gateway_rate_limit_sync_thread_restarts_total {rl_restarts}\n\
         # HELP gateway_rate_limit_redis_enabled 1 if Redis fleet sync is active\n\
         # TYPE gateway_rate_limit_redis_enabled gauge\n\
         gateway_rate_limit_redis_enabled {rl_redis_enabled}\n\
         # HELP redis_requests_total Total Redis operations attempted\n\
         # TYPE redis_requests_total counter\n\
         redis_requests_total {redis_req_total}\n\
         # HELP redis_success_total Successful Redis operations\n\
         # TYPE redis_success_total counter\n\
         redis_success_total {redis_ok_total}\n\
         # HELP redis_errors_total Redis operation errors (excludes timeouts)\n\
         # TYPE redis_errors_total counter\n\
         redis_errors_total {redis_err_total}\n\
         # HELP redis_timeouts_total Redis operation timeouts\n\
         # TYPE redis_timeouts_total counter\n\
         redis_timeouts_total {redis_to_total}\n\
         # HELP redis_circuit_state Circuit breaker state (0=CLOSED,1=OPEN,2=HALF_OPEN)\n\
         # TYPE redis_circuit_state gauge\n\
         redis_circuit_state {cb_state_val}\n\
         # HELP redis_circuit_open_total Times circuit transitioned to OPEN\n\
         # TYPE redis_circuit_open_total counter\n\
         redis_circuit_open_total {cb_open_total}\n\
         # HELP redis_circuit_half_open_total Times circuit transitioned to HALF_OPEN\n\
         # TYPE redis_circuit_half_open_total counter\n\
         redis_circuit_half_open_total {cb_half_open_total}\n\
         # HELP redis_circuit_rejected_total Requests rejected because circuit was OPEN or concurrency limit hit\n\
         # TYPE redis_circuit_rejected_total counter\n\
         redis_circuit_rejected_total {cb_rejected_total}\n\
         # HELP redis_inflight_current Current Redis operations in flight\n\
         # TYPE redis_inflight_current gauge\n\
         redis_inflight_current {cb_inflight}\n\
         # HELP redis_latency_p50_us Rolling p50 Redis latency in microseconds\n\
         # TYPE redis_latency_p50_us gauge\n\
         redis_latency_p50_us {cb_p50_us}\n\
         # HELP redis_latency_p95_us Rolling p95 Redis latency in microseconds\n\
         # TYPE redis_latency_p95_us gauge\n\
         redis_latency_p95_us {cb_p95_us}\n\
         # HELP redis_latency_p99_us Rolling p99 Redis latency in microseconds\n\
         # TYPE redis_latency_p99_us gauge\n\
         redis_latency_p99_us {cb_p99_us}\n\
         # HELP redis_error_rate_rolling Rolling error rate (0.0-1.0)\n\
         # TYPE redis_error_rate_rolling gauge\n\
         redis_error_rate_rolling {cb_err_rate:.4}\n"
    ));

    // Auth revocation-snapshot sync (ADR-0054) — live proof of edge↔Redis:
    // syncs tick every AUTH_SNAPSHOT_SYNC_SECS even with zero traffic.
    let (snap_gen, snap_age, snap_revoked, snap_tv) = crate::revocation::stats();
    let snap_ok  = crate::revocation::SYNC_OK_TOTAL.load(Ordering::Relaxed);
    let snap_err = crate::revocation::SYNC_ERROR_TOTAL.load(Ordering::Relaxed);
    out.push_str(&format!(
        "# HELP gateway_auth_snapshot_syncs_total Successful revocation-snapshot syncs from Redis\n\
         # TYPE gateway_auth_snapshot_syncs_total counter\n\
         gateway_auth_snapshot_syncs_total {snap_ok}\n\
         # HELP gateway_auth_snapshot_sync_errors_total Failed snapshot sync cycles\n\
         # TYPE gateway_auth_snapshot_sync_errors_total counter\n\
         gateway_auth_snapshot_sync_errors_total {snap_err}\n\
         # HELP gateway_auth_snapshot_generation Snapshot publish generation\n\
         # TYPE gateway_auth_snapshot_generation gauge\n\
         gateway_auth_snapshot_generation {snap_gen}\n\
         # HELP gateway_auth_snapshot_age_seconds Age of the local auth snapshot\n\
         # TYPE gateway_auth_snapshot_age_seconds gauge\n\
         gateway_auth_snapshot_age_seconds {snap_age}\n\
         # HELP gateway_auth_snapshot_revoked_entries Locally cached revoked-token keys\n\
         # TYPE gateway_auth_snapshot_revoked_entries gauge\n\
         gateway_auth_snapshot_revoked_entries {snap_revoked}\n\
         # HELP gateway_auth_snapshot_tv_floors Locally synced token-version floors\n\
         # TYPE gateway_auth_snapshot_tv_floors gauge\n\
         gateway_auth_snapshot_tv_floors {snap_tv}\n"
    ));

    // Active health checks (ADR-0061) — per-upstream up/down from probing.
    out.push_str(&crate::health::prometheus_fragment());
    let hc_checks = crate::health::CHECKS_TOTAL.load(Ordering::Relaxed);
    let hc_fails  = crate::health::CHECK_FAILURES_TOTAL.load(Ordering::Relaxed);
    out.push_str(&format!(
        "# HELP gateway_active_health_checks_total Active health probes sent\n\
         # TYPE gateway_active_health_checks_total counter\n\
         gateway_active_health_checks_total {hc_checks}\n\
         # HELP gateway_active_health_failures_total Failed active probes\n\
         # TYPE gateway_active_health_failures_total counter\n\
         gateway_active_health_failures_total {hc_fails}\n"
    ));

    // Per-user daily quotas (ADR-0066).
    let q_checks = crate::quota::QUOTA_CHECKS_TOTAL.load(Ordering::Relaxed);
    let q_rej    = crate::quota::QUOTA_REJECTED_TOTAL.load(Ordering::Relaxed);
    out.push_str(&format!(
        "# HELP gateway_quota_checks_total Quota pipeline checks executed\n\
         # TYPE gateway_quota_checks_total counter\n\
         gateway_quota_checks_total {q_checks}\n\
         # HELP gateway_quota_rejected_total Requests rejected for daily quota\n\
         # TYPE gateway_quota_rejected_total counter\n\
         gateway_quota_rejected_total {q_rej}\n"
    ));

    out
}
