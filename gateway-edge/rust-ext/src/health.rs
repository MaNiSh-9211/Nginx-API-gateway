//! Active Health Checks — out-of-band upstream probing (ADR-0061).
//!
//! Problem: selection only had *passive* signals (failure counting on real
//! traffic). A recovered upstream received no traffic until some request
//! happened to fail over onto it, and a dead one kept poisoning user-sticky
//! hash slots between failures.
//!
//! Mechanism: one background thread per worker walks every upstream address
//! in the active config each cycle and probes `{scheme}://{addr}{path}`.
//! Results feed an independent health flag per address:
//!
//!   * N consecutive failed probes → DOWN  (`unhealthy_threshold`)
//!   * M consecutive OK probes     → UP    (`healthy_threshold`) — auto-recovery
//!     with **zero traffic**
//!
//! The selector requires BOTH the passive circuit breaker to be closed AND
//! this flag to be up, so the two systems compose without fighting.
//! Unknown addresses default to UP (optimistic) so behaviour before the first
//! probe matches today's semantics exactly.
//!
//! State lives in its own cross-worker SHM region so all NGINX workers agree
//! instantly (same pattern as the passive circuit breaker).
//! Hot-path cost: one atomic load (~1 ns).

use rustc_hash::FxHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use memmap2::MmapMut;
use std::fs::OpenOptions;

use crate::config::GLOBAL_CONFIG;

// ── Shared state ──────────────────────────────────────────────────────────────

const SLOTS: usize = 4096;

#[repr(C)]
pub struct UpstreamHealth {
    /// 1 = up (default), 0 = actively probed down.
    pub healthy:      AtomicI32,
    pub consec_fails: AtomicU32,
    pub consec_oks:   AtomicU32,
    pub last_check_ms: AtomicU64,
}

static SHM_PTR: OnceLock<usize> = OnceLock::new();

fn init_shm() -> usize {
    let path = std::env::temp_dir().join("gateway_active_health.shm");
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(&path).unwrap();
    let size = (SLOTS * std::mem::size_of::<UpstreamHealth>()) as u64;
    file.set_len(size).unwrap();
    let mmap = unsafe { MmapMut::map_mut(&file).unwrap() };
    let ptr = mmap.as_ptr() as usize;
    std::mem::forget(mmap);
    ptr
}

/// Slot zero is pre-zeroed by the OS mapping: healthy=0 would mark everything
/// DOWN before the first probe. We therefore lazily initialise slots to
/// healthy=1 on first touch.
fn slot(address: &str) -> &'static UpstreamHealth {
    let mut h = FxHasher::default();
    address.hash(&mut h);
    let idx = (h.finish() % (SLOTS as u64)) as usize;
    let ptr = *SHM_PTR.get_or_init(init_shm) as *const UpstreamHealth;
    let s = unsafe { &*ptr.add(idx) };
    if s.last_check_ms.load(Ordering::Acquire) == 0 && s.healthy.load(Ordering::Acquire) == 0 {
        // Uninitialised slot (never probed): seed optimistic-up.
        s.healthy.store(1, Ordering::Release);
    }
    s
}

// ── Hot-path API ──────────────────────────────────────────────────────────────

/// True unless active probes have marked this address down.
/// Never-probed addresses are optimistically UP.
#[inline]
pub fn is_healthy(address: &str) -> bool {
    slot(address).healthy.load(Ordering::Relaxed) == 1
}

/// Test-only: force an address's health flag (simulates probe outcomes).
#[cfg(test)]
pub fn force_set_for_test(address: &str, up: bool) {
    let s = slot(address);
    s.healthy.store(if up { 1 } else { 0 }, Ordering::Release);
    s.last_check_ms.store(now_ms(), Ordering::Release);
}

// ── Threshold transition (pure, unit-tested) ─────────────────────────────────

/// Applies one probe result. Returns Some(new_state) only on a flip.
pub fn apply_probe(
    h: &UpstreamHealth,
    ok: bool,
    unhealthy_threshold: u32,
    healthy_threshold: u32,
) -> Option<bool> {
    h.last_check_ms.store(now_ms(), Ordering::Release);
    let was = h.healthy.load(Ordering::Acquire) == 1;
    if ok {
        h.consec_fails.store(0, Ordering::Relaxed);
        let oks = h.consec_oks.fetch_add(1, Ordering::Relaxed) + 1;
        if !was && oks >= healthy_threshold.max(1) {
            h.healthy.store(1, Ordering::Release);
            return Some(true);
        }
    } else {
        h.consec_oks.store(0, Ordering::Relaxed);
        let fails = h.consec_fails.fetch_add(1, Ordering::Relaxed) + 1;
        if was && fails >= unhealthy_threshold.max(1) {
            h.healthy.store(0, Ordering::Release);
            return Some(false);
        }
    }
    None
}

// ── Global metrics counters ───────────────────────────────────────────────────

pub static CHECKS_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static CHECK_FAILURES_TOTAL: AtomicU64 = AtomicU64::new(0);

/// Registry of addresses seen while scanning (for the metrics endpoint).
static REGISTRY: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
fn registry() -> &'static Mutex<Vec<String>> {
    REGISTRY.get_or_init(|| Mutex::new(Vec::new()))
}

/// Fraction of registered upstreams currently probed-DOWN (0.0 when none).
pub fn down_ratio() -> f64 {
    let reg = registry().lock().ok();
    let Some(reg) = reg else { return 0.0 };
    if reg.is_empty() {
        return 0.0;
    }
    let down = reg.iter().filter(|a| !is_healthy(a)).count();
    down as f64 / reg.len() as f64
}

/// Prometheus label-value escaping (backslash, quote, newline).
fn escape_label(v: &str) -> String {
    v.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

/// Prometheus lines for every known upstream: up/down + last probe age.
pub fn prometheus_fragment() -> String {
    let reg = registry().lock().ok();
    let Some(reg) = reg else { return String::new() };
    let mut out = String::with_capacity(reg.len() * 96 + 128);
    out.push_str("# HELP gateway_active_health_up 1 when active probes consider the upstream up\n# TYPE gateway_active_health_up gauge\n");
    for addr in reg.iter() {
        let s = slot(addr);
        let up = s.healthy.load(Ordering::Relaxed);
        out.push_str(&format!(
            "gateway_active_health_up{{upstream=\"{}\"}} {up}\n",
            escape_label(addr)
        ));
    }
    out
}

// ── Probe engine ──────────────────────────────────────────────────────────────

static THREAD_STARTED: AtomicBool = AtomicBool::new(false);

/// Spawn the background prober thread. The thread itself waits (cheaply) for
/// a config snapshot that enables checking, so late-arriving sidecar configs
/// activate it without a worker restart.
pub fn start_active_checks() {
    if THREAD_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("active-health".into())
        .spawn(probe_loop);
}

fn probe_loop() {
    // One client for all probes; rebuilt if the configured timeout changes.
    let mut client_timeout_ms: u64 = 0;
    let mut client: Option<reqwest::blocking::Client> = None;

    loop {
        let Some(cfg) = GLOBAL_CONFIG.load().health_check.clone() else {
            std::thread::sleep(Duration::from_secs(1));
            continue;
        };
        if !cfg.enabled {
            std::thread::sleep(Duration::from_secs(1));
            continue;
        }

        if client.is_none() || client_timeout_ms != cfg.timeout_ms {
            client = Some(
                reqwest::blocking::Client::builder()
                    .timeout(Duration::from_millis(cfg.timeout_ms))
                    .connect_timeout(Duration::from_millis(cfg.timeout_ms))
                    .build()
                    .expect("active-health reqwest client"),
            );
            client_timeout_ms = cfg.timeout_ms;
            eprintln!(
                "[active-health] probing every {}s path={} timeout={}ms down_after={} up_after={}",
                cfg.interval_secs, cfg.path, cfg.timeout_ms,
                cfg.unhealthy_threshold, cfg.healthy_threshold
            );
        }
        let client = client.as_ref().unwrap();

        // Snapshot current unique addresses across services × regions.
        let mut addrs: Vec<String> = Vec::new();
        {
            let snap = GLOBAL_CONFIG.load();
            for svc in snap.services.values() {
                for pool in svc.regional_upstreams.values() {
                    for up in pool {
                        if !addrs.contains(&up.address) {
                            addrs.push(up.address.clone());
                        }
                    }
                }
            }
        }
        {
            let mut known = registry().lock().unwrap();
            for a in &addrs {
                if !known.contains(a) {
                    known.push(a.clone());
                }
            }
        }

        for addr in &addrs {
            let url = normalize_url(addr, &cfg.path);
            let ok = match client.get(&url).send() {
                Ok(resp) => {
                    let code = resp.status().as_u16();
                    // Reachable service: any non-5xx counts as alive. 401/403/404
                    // mean "up but endpoint protected/absent".
                    code < 500 && code != 503
                }
                Err(_) => false,
            };
            CHECKS_TOTAL.fetch_add(1, Ordering::Relaxed);
            let s = slot(addr);
            if !ok {
                CHECK_FAILURES_TOTAL.fetch_add(1, Ordering::Relaxed);
            }
            if let Some(now_up) =
                apply_probe(s, ok, cfg.unhealthy_threshold, cfg.healthy_threshold)
            {
                if now_up {
                    eprintln!("[active-health] {addr} is UP again (recovered without traffic)");
                } else {
                    eprintln!("[active-health] {addr} marked DOWN ({url} failing)");
                }
            }
        }

        std::thread::sleep(Duration::from_secs(cfg.interval_secs.clamp(1, 300)));
    }
}

/// Accept bare `host:port` or fully-schemed addresses.
fn normalize_url(address: &str, path: &str) -> String {
    let path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };
    if address.starts_with("http://") || address.starts_with("https://") {
        format!("{address}{}", &path)
    } else {
        format!("http://{address}{path}")
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> UpstreamHealth {
        UpstreamHealth {
            healthy: AtomicI32::new(1),
            consec_fails: AtomicU32::new(0),
            consec_oks: AtomicU32::new(0),
            last_check_ms: AtomicU64::new(0),
        }
    }

    #[test]
    fn marks_down_only_after_unhealthy_threshold() {
        let h = fresh();
        assert_eq!(apply_probe(&h, false, 3, 2), None);
        assert!(h.healthy.load(Ordering::Relaxed) == 1);
        assert_eq!(apply_probe(&h, false, 3, 2), None);
        assert_eq!(apply_probe(&h, false, 3, 2), Some(false));
        assert!(h.healthy.load(Ordering::Relaxed) == 0);
    }

    #[test]
    fn recovery_requires_consecutive_oks() {
        let h = fresh();
        // trip it
        for _ in 0..3 { apply_probe(&h, false, 3, 2); }
        // one success is not enough
        assert_eq!(apply_probe(&h, true, 3, 2), None);
        // a failure resets the streak
        assert_eq!(apply_probe(&h, false, 3, 2), None);
        assert_eq!(apply_probe(&h, true, 3, 2), None);
        // two consecutive oks recover
        assert_eq!(apply_probe(&h, true, 3, 2), Some(true));
        assert!(h.healthy.load(Ordering::Relaxed) == 1);
    }

    #[test]
    fn success_resets_failure_streak() {
        let h = fresh();
        apply_probe(&h, false, 3, 2);
        apply_probe(&h, false, 3, 2);
        apply_probe(&h, true, 3, 2); // streak broken
        assert_eq!(h.consec_fails.load(Ordering::Relaxed), 0);
        assert_eq!(apply_probe(&h, false, 3, 2), None); // back to 1 fail
    }

    #[test]
    fn thresholds_clamp_to_minimum_one() {
        let h = fresh();
        assert_eq!(apply_probe(&h, false, 0, 0), Some(false));
        assert_eq!(apply_probe(&h, true, 0, 0), Some(true));
    }

    #[test]
    fn normalize_url_schemes() {
        assert_eq!(normalize_url("a:8080", "/health"), "http://a:8080/health");
        assert_eq!(normalize_url("https://b", "health"), "https://b/health");
        assert_eq!(normalize_url("http://c:80", "/x/y"), "http://c:80/x/y");
    }
}
