//! Multi-Layer Response Cache
//!
//! L1: Thread-local in-memory HashMap (per-worker, zero contention, ~5 ns lookup)
//! L2: NGINX `proxy_cache_path` (HTTP-level — production path for public routes)
//! L3: Redis (revocation/coordination, not response bodies — ADR-0017)
//!
//! L1 is unit-tested and exports hit/miss counters; L2 handles production caching.

#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Default TTL for cached responses in seconds
const DEFAULT_TTL_SECS: u64 = 30;

/// Maximum number of entries in L1 cache per worker
const L1_MAX_ENTRIES: usize = 5_000;

pub static CACHE_HITS: AtomicUsize = AtomicUsize::new(0);
pub static CACHE_MISSES: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Debug)]
pub struct CacheEntry {
    pub value: String,
    pub expires_at: u64,
    pub etag: String,
}

impl CacheEntry {
    pub fn is_valid(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        now < self.expires_at
    }
}

thread_local! {
    /// Per-worker L1 response cache — zero contention, no locks
    static L1_CACHE: RefCell<HashMap<String, CacheEntry>> =
        RefCell::new(HashMap::with_capacity(L1_MAX_ENTRIES));
}

/// Compute a cache key from method, path, and optional user identity.
pub fn cache_key(method: &str, path: &str, user_id: Option<&str>) -> String {
    match user_id {
        Some(uid) => format!("{method}:{path}:{uid}"),
        None => format!("{method}:{path}"),
    }
}

/// Look up the L1 cache. Returns `Some(entry)` on a valid (non-expired) hit.
pub fn l1_get(key: &str) -> Option<CacheEntry> {
    L1_CACHE.with(|cache| {
        let map = cache.borrow();
        if let Some(entry) = map.get(key) {
            if entry.is_valid() {
                CACHE_HITS.fetch_add(1, Ordering::Relaxed);
                return Some(entry.clone());
            }
        }
        CACHE_MISSES.fetch_add(1, Ordering::Relaxed);
        None
    })
}

/// Insert or update an L1 cache entry with optional TTL override.
pub fn l1_set(key: String, value: String, ttl_secs: Option<u64>, etag: String) {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let expires_at = now_secs + ttl_secs.unwrap_or(DEFAULT_TTL_SECS);

    L1_CACHE.with(|cache| {
        let mut map = cache.borrow_mut();

        // Evict expired entries first
        if map.len() >= L1_MAX_ENTRIES {
            map.retain(|_, v| v.expires_at > now_secs);
            // If still full after TTL eviction, drop the oldest half
            if map.len() >= L1_MAX_ENTRIES {
                let remove_count = map.len() / 2;
                let keys_to_remove: Vec<String> =
                    map.keys().take(remove_count).cloned().collect();
                for k in keys_to_remove {
                    map.remove(&k);
                }
            }
        }

        map.insert(key, CacheEntry { value, expires_at, etag });
    });
}

/// Invalidate a specific cache key (e.g., on a write operation).
pub fn l1_invalidate(key: &str) {
    L1_CACHE.with(|cache| {
        cache.borrow_mut().remove(key);
    });
}

/// Invalidate all keys whose cache key contains `prefix` (e.g., `/users/` on user update).
pub fn l1_invalidate_prefix(prefix: &str) {
    L1_CACHE.with(|cache| {
        cache.borrow_mut().retain(|k, _| !k.contains(prefix));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_key_with_user() {
        let key = cache_key("GET", "/api/items", Some("user123"));
        assert_eq!(key, "GET:/api/items:user123");
    }

    #[test]
    fn test_cache_key_anonymous() {
        let key = cache_key("GET", "/api/items", None);
        assert_eq!(key, "GET:/api/items");
    }

    #[test]
    fn test_cache_miss_then_hit() {
        let key = cache_key("GET", "/test/cache", None);
        assert!(l1_get(&key).is_none());
        l1_set(key.clone(), "response_body".into(), Some(60), "etag123".into());
        let hit = l1_get(&key);
        assert!(hit.is_some());
        assert_eq!(hit.unwrap().value, "response_body");
    }

    #[test]
    fn test_invalidate_clears_entry() {
        let key = cache_key("GET", "/api/clear-me", None);
        l1_set(key.clone(), "data".into(), Some(60), "e1".into());
        l1_invalidate(&key);
        assert!(l1_get(&key).is_none());
    }

    #[test]
    fn test_expired_entry_is_miss() {
        let key = cache_key("GET", "/api/expired", None);
        // TTL of 0 means already expired
        l1_set(key.clone(), "stale".into(), Some(0), "e2".into());
        // entry expires_at == now, so is_valid() returns false
        assert!(l1_get(&key).is_none());
    }
}
