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
         gateway_up 1\n"
    ));

    out
}
