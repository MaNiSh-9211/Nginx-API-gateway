//! Per-user daily quotas (ADR-0066) — gap #5.
//!
//! Rate limiting answers "how fast"; quotas answer "how much per day".
//! Policy lives on the service: `services[].quota.daily_limit` counts
//! authenticated requests per user per UTC day.
//!
//! Storage: Redis `INCR` with a first-write `EXPIRE`, key
//!   gateway:quota:{service}:{yyyymmdd}:{sha256_16(user)}
//! Fleet-wide exact counting; fail-OPEN when Redis is unreachable — a quota
//! is a billing guard, not a security control, and availability wins.
//! Hot-path cost: one pipeline round-trip ONLY for requests that opted in
//! (services without a quota policy skip entirely).

use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::auth;
use crate::config::QuotaPolicy;

pub static QUOTA_CHECKS_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static QUOTA_REJECTED_TOTAL: AtomicU64 = AtomicU64::new(0);

thread_local! {
    /// Per-worker persistent connection, dedicated to quota accounting.
    static QUOTA_CONN: RefCell<Option<redis::Connection>> = const { RefCell::new(None) };
}

/// Stable per-user shard of the counter key (no PII, fixed width).
fn user_shard(user_id: &str) -> String {
    let d = Sha256::digest(user_id.as_bytes());
    d.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// `yyyymmdd` for today (UTC) — pure integer math, no chrono dep.
pub fn utc_day_key() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86_400;
    // Howard Hinnant's civil-from-days algorithm.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}{m:02}{d:02}")
}

pub fn counter_key(service: &str, user_id: &str) -> String {
    format!("gateway:quota:{}:{}:{}", service, utc_day_key(), user_shard(user_id))
}

/// Pure decision: does this count exceed the limit?
pub fn exceeds(counter: u64, limit: u64) -> bool {
    limit > 0 && counter > limit
}

/// Increment and check. Fail-open on any Redis problem.
pub fn check_quota(service: &str, user_id: &str, policy: &QuotaPolicy) -> bool {
    QUOTA_CHECKS_TOTAL.fetch_add(1, Ordering::Relaxed);
    let key = counter_key(service, user_id);
    let ttl_secs: u64 = 90_000; // > 25 h so the day bucket always outlives itself

    let result = QUOTA_CONN.with(|cell| {
        let mut guard = cell.borrow_mut();
        // One bounded retry; a dead conn is dropped and rebuilt next call.
        for _ in 0..2 {
            if guard.is_none() {
                match auth::open_redis_connection() {
                    Some(c) => *guard = Some(c),
                    None => return Err(()),
                }
            }
            let con = match guard.as_mut() {
                Some(c) => c,
                None => return Err(()),
            };
            let r: Result<(i64, i64), redis::RedisError> = redis::pipe()
                .cmd("INCR").arg(&key)
                .cmd("EXPIRE").arg(&key).arg(ttl_secs).arg("NX")
                .query(con);
            match r {
                Ok((count, _)) => return Ok(count),
                Err(_) => {
                    *guard = None; // force reconnect next attempt/cycle
                }
            }
        }
        Err(())
    });

    match result {
        Ok(count) => {
            if exceeds(count as u64, policy.daily_limit) {
                QUOTA_REJECTED_TOTAL.fetch_add(1, Ordering::Relaxed);
                false
            } else {
                true
            }
        }
        Err(()) => true, // fail-open
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn counter_key_shape_is_stable_within_a_day() {
        let k1 = counter_key("api", "alice");
        let k2 = counter_key("api", "alice");
        assert_eq!(k1, k2);
        assert!(k1.starts_with("gateway:quota:api:"));
        assert_eq!(k1.len(), "gateway:quota:api:".len() + 8 + 1 + 16);
    }

    #[test]
    fn different_users_never_share_a_counter() {
        assert_ne!(counter_key("api", "alice"), counter_key("api", "bob"));
        assert_ne!(counter_key("api", "alice"), counter_key("other", "alice"));
    }

    #[test]
    fn day_key_rolls_format() {
        let k = utc_day_key();
        assert_eq!(k.len(), 8);
        assert!(k.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn exceeds_boundary_is_inclusive_over_limit() {
        assert!(!exceeds(99, 100));
        assert!(!exceeds(100, 100));
        assert!(exceeds(101, 100));
        assert!(!exceeds(u64::MAX, 0), "limit=0 disables quota checking");
    }

    #[test]
    fn user_shard_is_fixed_width_hex() {
        let s = user_shard("someone");
        assert_eq!(s.len(), 16);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn sleep_zero_smoke() {
        std::thread::sleep(Duration::from_millis(0));
    }
}
