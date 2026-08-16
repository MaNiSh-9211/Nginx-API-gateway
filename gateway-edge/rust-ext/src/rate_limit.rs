//! Rate Limiter — Cross-Process Shared Memory Token Bucket
//!
//! Architecture:
//!   - OS-level Memory Mapped File (`/tmp/gateway_rate_limit.shm`)
//!   - 1,000,000 slots of `AtomicU64` (~8MB footprint)
//!   - All NGINX worker processes map the same physical memory.
//!   - Zero-allocation, lock-free CAS loop.
//!   - Provides true node-global rate limiting instantly across all workers.

use rustc_hash::FxHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::sync::OnceLock;

const SHM_SLOTS: usize = 1_000_000;
const SHM_SIZE: usize = SHM_SLOTS * 8;

static SHM_PTR: OnceLock<usize> = OnceLock::new();

fn init_shm() -> usize {
    let path = std::env::temp_dir().join("gateway_rate_limit.shm");
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(&path).unwrap();

    file.set_len(SHM_SIZE as u64).unwrap();

    let mmap = unsafe { MmapMut::map_mut(&file).unwrap() };
    let ptr = mmap.as_ptr() as usize;
    // Leak the mmap so it stays mapped in this worker process forever
    std::mem::forget(mmap);
    ptr
}

fn get_bucket(key: u64) -> &'static AtomicU64 {
    let slot = (key % (SHM_SLOTS as u64)) as usize;
    let ptr = *SHM_PTR.get_or_init(init_shm) as *const AtomicU64;
    unsafe { &*ptr.add(slot) }
}

pub fn check_rate_limit(max_rps: usize, user_key: Option<&str>) -> bool {
    if max_rps == 0 {
        return true;
    }

    // Per-user limiting applies to AUTHENTICATED requests only (ADR-0007).
    // Anonymous traffic is rate-limited per-IP in the WAF (ADR-0006). Sending it
    // here would hash to a single fixed bucket (key 0) and collapse every
    // anonymous client node-wide into one shared counter — letting a single
    // client throttle all anonymous users, on top of double-counting the WAF's
    // per-IP limit. Skip it; the WAF owns anonymous rate limiting.
    let user_key = match user_key {
        Some(k) if !k.is_empty() => k,
        _ => return true,
    };

    let key = fx_hash(user_key);
    let bucket = get_bucket(key);

    let now = now_secs_u32();
    let mut current = bucket.load(Ordering::Relaxed);

    loop {
        let current_ts    = (current >> 32) as u32;
        let current_count = (current & 0xFFFF_FFFF) as u32;

        let new_val = if current_ts != now {
            ((now as u64) << 32) | 1
        } else {
            if current_count >= max_rps as u32 {
                return false;
            }
            ((now as u64) << 32) | (current_count + 1) as u64
        };

        match bucket.compare_exchange_weak(
            current, new_val, Ordering::AcqRel, Ordering::Relaxed,
        ) {
            Ok(_) => return true,
            Err(updated) => current = updated,
        }
    }
}

#[inline]
fn now_secs_u32() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as u32
}

#[inline]
fn fx_hash(key: &str) -> u64 {
    let mut h = FxHasher::default();
    key.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_when_max_zero() {
        assert!(check_rate_limit(0, Some("user-zero")));
        assert!(check_rate_limit(0, None));
    }

    #[test]
    fn anonymous_is_not_limited_here() {
        // Regression: anonymous (None) used to hash to bucket 0 and share one
        // global counter. It must now be skipped entirely (WAF owns per-IP).
        for _ in 0..1_000 {
            assert!(
                check_rate_limit(1, None),
                "anonymous requests must not be limited by the per-user bucket",
            );
        }
        // Empty user id is treated the same as anonymous.
        for _ in 0..1_000 {
            assert!(check_rate_limit(1, Some("")));
        }
    }

    #[test]
    fn authenticated_user_eventually_throttled() {
        // Unique key avoids cross-test bucket collisions in shared memory.
        let key = format!("rl-test-user-{}", std::process::id());
        let max = 3usize;
        let mut rejected = false;
        // Even if a 1s window boundary is crossed once mid-loop, 50 calls against
        // a limit of 3 must produce at least one rejection.
        for _ in 0..50 {
            if !check_rate_limit(max, Some(&key)) {
                rejected = true;
                break;
            }
        }
        assert!(rejected, "authenticated user over the limit must be throttled");
    }

    #[test]
    fn first_request_for_fresh_user_is_allowed() {
        let key = format!("rl-fresh-{}-{:?}", std::process::id(), std::time::SystemTime::now());
        assert!(check_rate_limit(10, Some(&key)));
    }
}
