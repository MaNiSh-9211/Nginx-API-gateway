//! Circuit Breaker — Cross-Process Shared Memory State Machine
//!
//! Replaces isolated DashMap with an OS-level Memory Mapped File.
//! All NGINX worker processes instantly share failure counters and threshold states.

use rustc_hash::FxHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::sync::OnceLock;

// ── State constants ───────────────────────────────────────────────────────────

pub const STATE_CLOSED:    usize = 0;
pub const STATE_OPEN:      usize = 1;
pub const STATE_HALF_OPEN: usize = 2;

const FAILURE_THRESHOLD:   usize = 50;
const RESET_TIMEOUT_SECS:  u64   = 10;
const SHM_SLOTS: usize = 4096;

#[repr(C)]
pub struct UpstreamCB {
    pub state:             AtomicUsize,
    pub failures:          AtomicUsize,
    pub last_failure_time: AtomicU64,
}

static SHM_PTR: OnceLock<usize> = OnceLock::new();

fn init_shm() -> usize {
    let path = std::env::temp_dir().join("gateway_circuit_breaker.shm");
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(&path).unwrap();

    let size = (SHM_SLOTS * std::mem::size_of::<UpstreamCB>()) as u64;
    file.set_len(size).unwrap();

    let mmap = unsafe { MmapMut::map_mut(&file).unwrap() };
    let ptr = mmap.as_ptr() as usize;
    std::mem::forget(mmap);
    ptr
}

fn get_cb(name: &str) -> &'static UpstreamCB {
    let mut h = FxHasher::default();
    name.hash(&mut h);
    let index = (h.finish() % (SHM_SLOTS as u64)) as usize;
    
    let ptr = *SHM_PTR.get_or_init(init_shm) as *const UpstreamCB;
    unsafe { &*ptr.add(index) }
}

impl UpstreamCB {
    pub fn is_open(&self) -> bool {
        let state = self.state.load(Ordering::Relaxed);
        match state {
            STATE_CLOSED => false,
            STATE_OPEN => {
                let last_fail = self.last_failure_time.load(Ordering::Relaxed);
                if now_secs() <= last_fail + RESET_TIMEOUT_SECS {
                    return true;
                }
                // Cooldown elapsed: one worker CASes OPEN → HALF_OPEN for probing.
                // If CAS fails because another worker already moved to HALF_OPEN,
                // we must NOT treat the circuit as open — that would block all
                // recovery probes (ADR-0048).
                match self.state.compare_exchange(
                    STATE_OPEN,
                    STATE_HALF_OPEN,
                    Ordering::AcqRel,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => false,
                    Err(current) => current != STATE_HALF_OPEN,
                }
            }
            STATE_HALF_OPEN => false,
            _ => false,
        }
    }

    pub fn record_success(&self) {
        let state = self.state.load(Ordering::Relaxed);
        match state {
            STATE_HALF_OPEN => {
                self.state.store(STATE_CLOSED, Ordering::Release);
                self.failures.store(0, Ordering::Relaxed);
            }
            STATE_CLOSED => {
                self.failures.store(0, Ordering::Relaxed);
            }
            _ => {}
        }
    }

    pub fn record_failure(&self) {
        let state = self.state.load(Ordering::Relaxed);
        match state {
            STATE_HALF_OPEN => {
                self.state.store(STATE_OPEN, Ordering::Release);
                self.last_failure_time.store(now_secs(), Ordering::Relaxed);
            }
            STATE_CLOSED => {
                let fails = self.failures.fetch_add(1, Ordering::Relaxed) + 1;
                if fails >= FAILURE_THRESHOLD
                    && self
                        .state
                        .compare_exchange(
                            STATE_CLOSED,
                            STATE_OPEN,
                            Ordering::AcqRel,
                            Ordering::Relaxed,
                        )
                        .is_ok()
                {
                    self.last_failure_time.store(now_secs(), Ordering::Relaxed);
                }
            }
            _ => {}
        }
    }

    pub fn state_value(&self) -> usize {
        self.state.load(Ordering::Relaxed)
    }
}

pub fn is_upstream_open(upstream: &str) -> bool {
    get_cb(upstream).is_open()
}

pub fn record_success_for(upstream: &str) {
    get_cb(upstream).record_success();
    get_cb("__GLOBAL__").record_success();
}

pub fn record_failure_for(upstream: &str) {
    get_cb(upstream).record_failure();
    get_cb("__GLOBAL__").record_failure();
}

pub fn record_success() {
    get_cb("__GLOBAL__").record_success();
}

pub fn record_failure() {
    get_cb("__GLOBAL__").record_failure();
}

pub fn global_state() -> usize {
    get_cb("__GLOBAL__").state_value()
}

/// ── Soft circuit breaker (ADR-0072) ──────────────────────────────────────────
/// A 0–100 *confidence score* per upstream, derived from the same SHM counters
/// the hard breaker uses. The selector uses it as a continuous weight instead
/// of treating health as binary: a slightly-worn upstream still wins traffic,
/// just less of it, and recovers proportionally as evidence improves.
///
///   OPEN (cooldown)      → 5    effectively benched
///   HALF_OPEN            → 40   probing, trusted a little
///   CLOSED w/ failures f → max(30, 100 − f×4)  graceful slide
///   CLOSED clean         → 100
pub fn get_confidence(upstream: &str) -> u8 {
    let cb = get_cb(upstream);
    match cb.state.load(Ordering::Relaxed) {
        STATE_OPEN => 5,
        STATE_HALF_OPEN => 40,
        _ => {
            let f = cb.failures.load(Ordering::Relaxed);
            (100u32.saturating_sub(f as u32 * 4)).clamp(30, 100) as u8
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_cb() -> UpstreamCB {
        UpstreamCB {
            state: AtomicUsize::new(STATE_CLOSED),
            failures: AtomicUsize::new(0),
            last_failure_time: AtomicU64::new(0),
        }
    }

    #[test]
    fn closed_is_not_open() {
        assert!(!fresh_cb().is_open());
    }

    #[test]
    fn open_within_cooldown_blocks() {
        let cb = fresh_cb();
        cb.state.store(STATE_OPEN, Ordering::Relaxed);
        cb.last_failure_time.store(now_secs(), Ordering::Relaxed);
        assert!(cb.is_open());
    }

    #[test]
    fn open_after_cooldown_transitions_to_half_open() {
        let cb = fresh_cb();
        cb.state.store(STATE_OPEN, Ordering::Relaxed);
        cb.last_failure_time
            .store(now_secs().saturating_sub(RESET_TIMEOUT_SECS + 1), Ordering::Relaxed);
        assert!(!cb.is_open());
        assert_eq!(cb.state_value(), STATE_HALF_OPEN);
    }

    #[test]
    fn half_open_is_not_open() {
        let cb = fresh_cb();
        cb.state.store(STATE_HALF_OPEN, Ordering::Relaxed);
        assert!(!cb.is_open());
    }

    #[test]
    fn half_open_success_closes_circuit() {
        let cb = fresh_cb();
        cb.state.store(STATE_HALF_OPEN, Ordering::Relaxed);
        cb.record_success();
        assert_eq!(cb.state_value(), STATE_CLOSED);
    }

    #[test]
    fn half_open_failure_reopens_circuit() {
        let cb = fresh_cb();
        cb.state.store(STATE_HALF_OPEN, Ordering::Relaxed);
        cb.record_failure();
        assert_eq!(cb.state_value(), STATE_OPEN);
    }

    #[test]
    fn cas_loser_sees_half_open_allows_traffic() {
        // Simulates worker B arriving after worker A won OPEN → HALF_OPEN.
        let cb = fresh_cb();
        cb.state.store(STATE_HALF_OPEN, Ordering::Relaxed);
        cb.last_failure_time
            .store(now_secs().saturating_sub(RESET_TIMEOUT_SECS + 1), Ordering::Relaxed);
        // is_open() must not block when state is already HALF_OPEN (ADR-0048).
        assert!(!cb.is_open());
    }
}
