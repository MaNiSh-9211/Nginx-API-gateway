//! Latency Debt Ledger (ADR-0077) -- INVENTION #6.
//!
//! Every gateway treats upstream health as binary: works or doesn't.
//! But the most dangerous degradation is SILENT: backend returns 200 OK,
//! just 3 seconds instead of 30ms. No breaker trips. No alert fires.
//!
//! The Debt Ledger treats SLA violations as accumulated DEBT that each
//! upstream must repay through consistently fast responses. Debt decays
//! exponentially, creating a natural credit market for traffic.

use rustc_hash::FxHasher;
use std::hash::{Hash, Hasher};
use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const DEBT_HALF_LIFE_MS: u64 = 30_000;
const SLOTS: usize = 4_096;

#[repr(C)]
pub struct UpstreamDebt {
    pub debt_us: AtomicU64,
    pub last_update_ms: AtomicU64,
}

static SHM_PTR: OnceLock<usize> = OnceLock::new();

fn init_shm() -> usize {
    let path = std::env::temp_dir().join("gateway_latency_debt.shm");
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(&path).unwrap();
    let size = (SLOTS * std::mem::size_of::<UpstreamDebt>()) as u64;
    file.set_len(size).unwrap();
    let mmap = unsafe { memmap2::MmapMut::map_mut(&file).unwrap() };
    let ptr = mmap.as_ptr() as usize;
    std::mem::forget(mmap);
    ptr
}

fn get_debt(address: &str) -> &'static UpstreamDebt {
    let mut h = FxHasher::default();
    address.hash(&mut h);
    let idx = (h.finish() % (SLOTS as u64)) as usize;
    let ptr = *SHM_PTR.get_or_init(init_shm) as *const UpstreamDebt;
    unsafe { &*ptr.add(idx) }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Exponential decay: debt halves every DEBT_HALF_LIFE_MS.
fn apply_decay(debt: u64, elapsed_ms: u64) -> u64 {
    if elapsed_ms == 0 { return debt; }
    let half_lives = elapsed_ms as f64 / DEBT_HALF_LIFE_MS as f64;
    (debt as f64 * 0.5_f64.powf(half_lives)) as u64
}

/// Record an observed latency against the route time budget.
pub fn record_observation(upstream: &str, actual_us: u64, budget_us: u64) {
    let d = get_debt(upstream);
    let now = now_ms();
    let last = d.last_update_ms.load(Ordering::Acquire);
    if last > 0 && now > last {
        let elapsed = now - last;
        let old = d.debt_us.load(Ordering::Relaxed);
        let decayed = apply_decay(old, elapsed);
        d.debt_us.store(decayed, Ordering::Release);
    }
    if actual_us > budget_us {
        let overage = actual_us - budget_us;
        let current = d.debt_us.load(Ordering::Relaxed);
        let new_debt = (current + overage).min(10_000_000); // cap at 10s
        d.debt_us.store(new_debt, Ordering::Release);
    }
    d.last_update_ms.store(now, Ordering::Release);
}

/// Read current debt for LB scoring. Applies decay before reading.
pub fn read_debt(upstream: &str) -> u64 {
    let d = get_debt(upstream);
    let last = d.last_update_ms.load(Ordering::Acquire);
    let raw = d.debt_us.load(Ordering::Relaxed);
    if last == 0 { return 0; }
    let elapsed = now_ms().saturating_sub(last);
    apply_decay(raw, elapsed)
}
