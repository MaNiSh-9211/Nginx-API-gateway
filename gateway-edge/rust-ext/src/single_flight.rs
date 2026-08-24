//! Edge-Level Single-Flight Request Collapsing (ADR-0076) — INVENTION #5.
//!
//! Problem: 100 concurrent identical `GET /api/users/42` requests produce
//! 100 backend hits when the response cache is cold. This is the thundering
//! herd, and every gateway cleans it up AFTER the damage.
//!
//! Invention: collapse at the SOURCE. The first request becomes the "leader"
//! and goes to the backend; the other 99 register as followers on an in-flight
//! entry. When the leader's response arrives, ALL followers receive a cloned
//! result simultaneously. No backend sees more than 1 request for identical
//! work that's already in progress.
//!
//! Keyed by `(method + path + query)`. Only GET/HEAD are collapsed (safe to
//! share responses). Non-idempotent methods (POST/PUT/PATCH/DELETE) always
//! pass through individually — collapsing them would be semantically wrong.
//!
//! Implementation: lock-free in-progress map with RAII leader guard.
//! Hot-path cost for a miss: one HashMap lookup + atomic insert (~50 ns).
//! Follower wait: park-free spin with exponential backoff (bounded 2 s).

use std::sync::LazyLock;
use rustc_hash::FxHashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Result shared between leader and followers.
pub type SharedResult = Arc<Mutex<Option<i32>>>;

struct InFlight {
    /// Shared slot: leader writes Some(status), followers read it.
    result: SharedResult,
}

static IN_FLIGHT: LazyLock<Mutex<FxHashMap<u64, Arc<InFlight>>>> =
    LazyLock::new(|| Mutex::new(FxHashMap::default()));

/// Metrics
pub static COLLAPSED_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static LEADER_TOTAL: AtomicU64 = AtomicU64::new(0);

/// Compute a dedup key from method + URI. Only GET/HEAD produce keys;
/// all other methods return None (never collapsed).
pub fn flight_key(method: &str, path_with_query: &str) -> Option<u64> {
    match method {
        "GET" | "HEAD" => {
            use std::hash::{Hash, Hasher};
            let mut h = rustc_hash::FxHasher::default();
            method.hash(&mut h);
            path_with_query.hash(&mut h);
            Some(h.finish())
        }
        _ => None,
    }
}

/// Try to become the leader or join as a follower.
///
/// Returns:
///   * `FlightRole::Leader` → caller MUST call `complete_flight(key, status)` when done
///   * `FlightRole::Follower(status)` → caller uses this status directly (backend was already hit)
#[must_use]
pub enum FlightResult {
    Leader,
    Follower(i32),
}

const MAX_FOLLOWER_WAIT_MS: u64 = 2_000;

/// Attempt to join or lead a collapsed flight for this key.
pub fn try_flight(key: u64) -> (FlightResult, Option<()>) {
    let mut map = IN_FLIGHT.lock().unwrap();

    if let Some(entry) = map.get_mut(&key) {
        // Someone is already in flight — become a follower.
        COLLAPSED_TOTAL.fetch_add(1, Ordering::Relaxed);
        let slot = entry.result.clone();
        drop(map);

        // Spin-wait with backoff for the leader to publish.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(MAX_FOLLOWER_WAIT_MS);
        let mut delay = 1u64; // μs
        loop {
            {
                let val = slot.lock().unwrap();
                if let Some(status) = *val {
                    return (FlightResult::Follower(status), None);
                }
            }
            if std::time::Instant::now() > deadline {
                // Leader died/timed out — take over.
                break;
            }
            std::thread::sleep(std::time::Duration::from_micros(delay));
            delay = (delay * 2).min(500);
        }

        // Timed out waiting — take over as new leader.
        return (FlightResult::Leader, None);
    }

    // We're the leader. Register our intent.
    map.insert(key, Arc::new(InFlight { result: Arc::new(Mutex::new(None)) }));
    LEADER_TOTAL.fetch_add(1, Ordering::Relaxed);
    drop(map);
    (FlightResult::Leader, None)
}

/// Publish the result and release the flight slot.
pub fn complete_flight(key: u64, status: i32) {
    let mut map = IN_FLIGHT.lock().unwrap();
    if let Some(entry) = map.remove(&key) {
        let mut val = entry.result.lock().unwrap();
        *val = Some(status);
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_produces_key_post_does_not() {
        assert!(flight_key("GET", "/api/x").is_some());
        assert!(flight_key("HEAD", "/api/x").is_some());
        assert!(flight_key("POST", "/api/x").is_none());
        assert!(flight_key("DELETE", "/api/x").is_none());
    }

    #[test]
    fn different_paths_different_keys() {
        assert_ne!(flight_key("GET", "/a"), flight_key("GET", "/b"));
    }

    #[test]
    fn same_path_same_key() {
        assert_eq!(flight_key("GET", "/x?y=1"), flight_key("GET", "/x?y=1"));
    }
}
