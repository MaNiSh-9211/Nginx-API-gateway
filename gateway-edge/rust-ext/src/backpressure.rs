//! Backpressure & Overload Protection
//!
//! Design:
//!   - Global in-flight request counter (AtomicI64)
//!   - Configurable concurrency limit from GLOBAL_CONFIG (ArcSwap)
//!   - Fail-fast rejection when limit exceeded → 503
//!   - Adaptive: tightens limit to 10% when global circuit is half-open
//!   - Rejects all traffic when global circuit is fully open
//!
//! This runs FIRST in the hot path — before WAF, auth, rate-limit.
//! Cost: ~5 ns (one AtomicI64 fetch_add + one load).

use std::sync::atomic::{AtomicI64, Ordering};
use crate::config::GLOBAL_CONFIG;
use crate::load_balancing::{global_state, STATE_CLOSED, STATE_HALF_OPEN};

/// Active in-flight request count (gauge)
pub static IN_FLIGHT: AtomicI64 = AtomicI64::new(0);

/// Acquire a concurrency slot.
/// Returns `true` if the request is allowed to proceed.
/// MUST be paired with `release()` on ALL code paths (including error paths).
pub fn acquire() -> bool {
    let config = GLOBAL_CONFIG.load();
    let cb = global_state();

    let limit: i64 = if cb == STATE_HALF_OPEN {
        // Conservative: only allow 10% of normal capacity during probe
        (config.global_max_concurrency / 10).max(1) as i64
    } else if cb == STATE_CLOSED {
        config.global_max_concurrency as i64
    } else {
        // Circuit OPEN — reject all traffic immediately
        return false;
    };

    let current = IN_FLIGHT.fetch_add(1, Ordering::AcqRel);
    if current >= limit {
        IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
        return false;
    }
    true
}

/// Release a concurrency slot. Called after every request completes.
pub fn release() {
    IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
}

/// Returns current in-flight count (for telemetry and Prometheus metrics).
pub fn current_in_flight() -> i64 {
    IN_FLIGHT.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_in_flight_starts_non_negative() {
        assert!(current_in_flight() >= 0);
    }

    #[test]
    fn test_release_decrements() {
        let before = current_in_flight();
        IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
        release();
        assert_eq!(current_in_flight(), before);
    }
}
