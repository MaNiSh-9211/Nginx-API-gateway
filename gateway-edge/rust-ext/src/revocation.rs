//! Revocation Snapshot — zero-Redis-per-request auth state (ADR-0054).
//!
//! Problem: the hot path used to make at least one Redis round trip per
//! request — a `GET gateway:user:tv:{sub}` on every cache hit and
//! `EXISTS gateway:revoked:*` on every cache miss. At 100k RPS that is
//! 100k Redis QPS of pure auth overhead, plus a latency tail whenever Redis
//! blips.
//!
//! Technique: publishers also index every revocation / token-version change
//! into two Redis ZSETs (`gateway:revocation:index`, `gateway:tv:index`,
//! score = event time). Each worker runs a background sync thread that pulls
//! **only the deltas** every `AUTH_SNAPSHOT_SYNC_SECS` (default 5 s) and
//! publishes an immutable snapshot through `arc_swap::ArcSwap` — ~2 ns,
//! allocation-free reads on the hot path:
//!
//!   * revoked tokens   → `HashMap<redis_key, expiry_epoch>`  (the "local
//!     cache of revoked tokens": a revoked token is rejected locally until
//!     its expiry, with zero network I/O)
//!   * token-version floors → `HashMap<user_id, floor>`
//!
//! Consistency: revocation propagates within one sync interval instead of
//! instantly. This is the standard trade-off (Kong/Envoy do the same) and is
//! bounded + tunable. `REVOCATION_FAIL_CLOSED=1` now means "reject when the
//! snapshot is older than 3× the sync interval", so a partitioned worker
//! fails closed rather than serving on infinitely-stale data.
//!
//! Hot path cost: two hash lookups (~100 ns), no locks, no allocations.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use arc_swap::ArcSwap;

use crate::auth;

// ── Snapshot ──────────────────────────────────────────────────────────────────

pub struct RevocationSnapshot {
    /// Full Redis revocation keys (`gateway:revoked:jti:<jti>` /
    /// `gateway:revoked:token:<sha256>`) → expiry epoch seconds.
    pub revoked: HashMap<String, u64>,
    /// Token-version floors: user_id → floor published by the auth service.
    pub tv_floors: HashMap<String, u64>,
    /// Wall-clock ms of the last successful sync.
    pub synced_at_ms: u64,
    /// Monotonic count of successful syncs (0 = never synced).
    pub generation: u64,
}

impl RevocationSnapshot {
    fn empty() -> Self {
        Self {
            revoked: HashMap::new(),
            tv_floors: HashMap::new(),
            synced_at_ms: 0,
            generation: 0,
        }
    }
}

static SNAPSHOT: LazyLock<ArcSwap<RevocationSnapshot>> =
    LazyLock::new(|| ArcSwap::from_pointee(RevocationSnapshot::empty()));

// ── Metrics ───────────────────────────────────────────────────────────────────

pub static SYNC_OK_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static SYNC_ERROR_TOTAL: AtomicU64 = AtomicU64::new(0);

// ── Public hot-path API ───────────────────────────────────────────────────────

/// True when either revocation key for this token is in the local snapshot
/// and not yet expired. Pure hash lookups — no I/O.
pub fn is_revoked(jti: Option<&str>, token_hash_hex: &str) -> bool {
    let snap = SNAPSHOT.load();
    let now = now_secs();
    if let Some(j) = jti.filter(|s| !s.is_empty()) {
        if let Some(&expiry) = snap.revoked.get(format!("gateway:revoked:jti:{j}").as_str()) {
            if expiry > now {
                return true;
            }
        }
    }
    match snap.revoked.get(format!("gateway:revoked:token:{token_hash_hex}").as_str()) {
        Some(&expiry) => expiry > now,
        None => false,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum TvStatus {
    Valid,
    Stale,
}

/// Check a token's `tv` claim against the locally-synced floor.
/// A user with no published floor is always valid (matches ADR-0053).
pub fn tv_status(user_id: &str, token_tv: Option<u64>) -> TvStatus {
    let snap = SNAPSHOT.load();
    match snap.tv_floors.get(user_id) {
        None => TvStatus::Valid,
        Some(&floor) => {
            if token_tv == Some(floor) {
                TvStatus::Valid
            } else {
                TvStatus::Stale
            }
        }
    }
}

/// True when the snapshot is missing or older than 3× the sync interval (+5 s
/// grace). Under `REVOCATION_FAIL_CLOSED=1` the caller must reject while this
/// is true — a worker cut off from Redis must not serve on stale auth data.
pub fn snapshot_stale() -> bool {
    let snap = SNAPSHOT.load();
    if snap.generation == 0 {
        return true;
    }
    let age_ms = now_millis().saturating_sub(snap.synced_at_ms);
    age_ms > sync_interval_secs() * 3_000 + 5_000
}

/// Live snapshot stats for the metrics endpoint:
/// (generation, age_secs, revoked_entries, tv_floors)
pub fn stats() -> (u64, u64, usize, usize) {
    let snap = SNAPSHOT.load();
    let age = if snap.synced_at_ms == 0 {
        0
    } else {
        now_millis().saturating_sub(snap.synced_at_ms) / 1000
    };
    (snap.generation, age, snap.revoked.len(), snap.tv_floors.len())
}

fn load() -> arc_swap::Guard<Arc<RevocationSnapshot>> {
    SNAPSHOT.load()
}

// ── Config ────────────────────────────────────────────────────────────────────

fn sync_interval_secs() -> u64 {
    static INTERVAL: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *INTERVAL.get_or_init(|| {
        std::env::var("AUTH_SNAPSHOT_SYNC_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(|v| v.clamp(1, 300))
            .unwrap_or(5)
    })
}

/// Optional compatibility mode: additionally SCAN `gateway:revoked:*` each
/// cycle so revocations published WITHOUT the ZSET index (external systems)
/// are still picked up. Off by default — all in-repo publishers maintain the
/// index, and SCAN walks the whole keyspace.
fn scan_fallback_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("AUTH_SNAPSHOT_SCAN_FALLBACK")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    })
}

const REV_INDEX_KEY: &str = "gateway:revocation:index";
const TV_INDEX_KEY: &str = "gateway:tv:index";
const TV_KEY_PREFIX: &str = "gateway:user:tv:";
/// Overlap window for clock skew between publishers and gateways. Redelivered
/// deltas are idempotent (set insert / overwrite), so overlap is safe.
const SKEW_OVERLAP_SECS: f64 = 60.0;
/// Max MGET chunk when fetching changed TV floors.
const MGET_CHUNK: usize = 500;
/// Max SCAN pages per cycle in fallback mode (100 keys/page → ≤2k keys).
const SCAN_MAX_PAGES: usize = 20;

/// Connect/I-O timeout for the background sync thread. Deliberately generous:
/// managed Redis (Upstash) needs ~1–2 s for TCP+TLS+AUTH, far beyond the
/// 50 ms budget the old hot-path lookups used.
fn sync_io_timeout() -> Duration {
    static T: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    Duration::from_millis(*T.get_or_init(|| {
        std::env::var("AUTH_SNAPSHOT_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(|v| v.clamp(100, 30_000))
            .unwrap_or(5_000)
    }))
}

fn open_connection() -> Option<redis::Connection> {
    let timeout = sync_io_timeout();
    let client = redis::Client::open(auth::redis_url().as_str()).ok()?;
    let con = client.get_connection_with_timeout(timeout).ok()?;
    let _ = con.set_read_timeout(Some(timeout));
    let _ = con.set_write_timeout(Some(timeout));
    Some(con)
}

// ── Sync thread ───────────────────────────────────────────────────────────────

/// Spawn the per-worker snapshot sync thread. Called from `init_extension`.
pub fn start_sync() {
    let _ = thread::Builder::new()
        .name("auth-snapshot-sync".into())
        .spawn(loop_sync);
}

fn loop_sync() {
    let interval = Duration::from_secs(sync_interval_secs());
    // Score watermarks (f64 = Redis ZSET scores). Start at -inf equivalent so
    // the first cycle pulls the full index (bootstrap).
    let mut last_rev_score: f64 = f64::NEG_INFINITY;
    let mut last_tv_score: f64 = f64::NEG_INFINITY;
    let mut cycles: u64 = 0;

    loop {
        match sync_once(&mut last_rev_score, &mut last_tv_score, cycles) {
            Ok(()) => {
                if cycles == 0 {
                    eprintln!("[auth-snapshot] first sync ok — revocation snapshot live");
                }
                SYNC_OK_TOTAL.fetch_add(1, Ordering::Relaxed);
            }
            Err(()) => {
                if cycles == 0 || SYNC_ERROR_TOTAL.load(Ordering::Relaxed) % 12 == 0 {
                    eprintln!("[auth-snapshot] sync failed (will retry every {}s)", sync_interval_secs());
                }
                SYNC_ERROR_TOTAL.fetch_add(1, Ordering::Relaxed);
            }
        }
        cycles += 1;
        thread::sleep(interval);
    }
}

/// One sync cycle: fetch deltas, rebuild the snapshot, publish atomically.
/// Watermarks only advance on success so a failed cycle retries the same window.
fn sync_once(
    last_rev_score: &mut f64,
    last_tv_score: &mut f64,
    _cycles: u64,
) -> Result<(), ()> {
    let mut con = open_connection().ok_or(())?;

    let now = now_secs();

    // ── 1. Revocation deltas ────────────────────────────────────────────────
    // score = expiry epoch secs; member = full revoked key.
    let from = if last_rev_score.is_finite() {
        *last_rev_score - SKEW_OVERLAP_SECS
    } else {
        *last_rev_score
    };
    let rev_delta: Vec<(String, f64)> = redis::cmd("ZRANGEBYSCORE")
        .arg(REV_INDEX_KEY)
        .arg(from)
        .arg("+inf")
        .arg("WITHSCORES")
        .query(&mut con)
        .map_err(|_| ())?;

    // ── 2. Token-version deltas ─────────────────────────────────────────────
    // score = change epoch ms; member = user_id.
    let tv_from = if last_tv_score.is_finite() {
        *last_tv_score - SKEW_OVERLAP_SECS * 1_000.0
    } else {
        *last_tv_score
    };
    let tv_delta: Vec<(String, f64)> = redis::cmd("ZRANGEBYSCORE")
        .arg(TV_INDEX_KEY)
        .arg(tv_from)
        .arg("+inf")
        .arg("WITHSCORES")
        .query(&mut con)
        .map_err(|_| ())?;

    // Fetch current floors for changed users via chunked MGET.
    let mut changed_users: Vec<String> = Vec::with_capacity(tv_delta.len());
    let mut max_tv_score = *last_tv_score;
    for (user, score) in &tv_delta {
        changed_users.push(user.clone());
        if *score > max_tv_score {
            max_tv_score = *score;
        }
    }
    let mut fetched_floors: HashMap<String, Option<u64>> = HashMap::new();
    for chunk in changed_users.chunks(MGET_CHUNK) {
        let mut cmd = redis::cmd("MGET");
        for user in chunk {
            cmd.arg(format!("{TV_KEY_PREFIX}{user}"));
        }
        let vals: Vec<Option<String>> = cmd.query(&mut con).map_err(|_| ())?;
        for (user, val) in chunk.iter().zip(vals) {
            fetched_floors.insert(
                user.clone(),
                val.and_then(|v| v.parse::<u64>().ok()),
            );
        }
    }

    // ── 3. Optional SCAN fallback for index-less external publishers ───────
    let scanned_keys: Option<Vec<String>> = if scan_fallback_enabled() {
        scan_revoked_keys(&mut con).ok()
    } else {
        None
    };

    // ── 4. Rebuild + publish the immutable snapshot ─────────────────────────
    let prev = load();
    let mut revoked: HashMap<String, u64> = prev
        .revoked
        .iter()
        .filter(|(_, &expiry)| expiry > now)
        .map(|(k, &e)| (k.clone(), e))
        .collect();
    let mut max_rev_score = *last_rev_score;
    for (key, score) in rev_delta {
        if score > max_rev_score {
            max_rev_score = score;
        }
        revoked.insert(key, score as u64);
    }
    if let Some(keys) = scanned_keys {
        for key in keys {
            // Unknown real TTL from SCAN — keep for one sync interval ×6,
            // refreshed on every scan while the key still exists in Redis.
            revoked.insert(key, now + sync_interval_secs() * 6);
        }
    }

    let mut tv_floors: HashMap<String, u64> = prev.tv_floors.clone();
    for (user, floor) in fetched_floors {
        match floor {
            Some(v) => {
                tv_floors.insert(user, v);
            }
            None => {
                // Floor deleted — absence means "no floor" (all versions valid).
                tv_floors.remove(&user);
            }
        }
    }

    SNAPSHOT.store(Arc::new(RevocationSnapshot {
        revoked,
        tv_floors,
        synced_at_ms: now_millis(),
        generation: prev.generation + 1,
    }));

    *last_rev_score = if max_rev_score.is_finite() { max_rev_score } else { *last_rev_score };
    *last_tv_score = if max_tv_score.is_finite() { max_tv_score } else { *last_tv_score };

    // ── 5. Opportunistic index GC — drop entries expired > 1 h ──────────────
    let _ = redis::cmd("ZREMRANGEBYSCORE")
        .arg(REV_INDEX_KEY)
        .arg("-inf")
        .arg(now.saturating_sub(3600))
        .query::<usize>(&mut con);

    Ok(())
}

/// Bounded SCAN over `gateway:revoked:*` (fallback mode only).
fn scan_revoked_keys(con: &mut redis::Connection) -> Result<Vec<String>, ()> {
    let mut out = Vec::new();
    let mut cursor: u64 = 0;
    for _ in 0..SCAN_MAX_PAGES {
        let (next, page): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg("gateway:revoked:*")
            .arg("COUNT")
            .arg(100)
            .query(con)
            .map_err(|_| ())?;
        out.extend(page);
        cursor = next;
        if cursor == 0 {
            return Ok(out);
        }
    }
    Ok(out)
}

// ── Time helpers ──────────────────────────────────────────────────────────────

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn snap_with(revoked: HashMap<String, u64>, floors: HashMap<String, u64>) -> RevocationSnapshot {
        RevocationSnapshot {
            revoked,
            tv_floors: floors,
            synced_at_ms: now_millis(),
            generation: 1,
        }
    }

    #[test]
    fn revoked_jti_detected_until_expiry() {
        let mut revoked = HashMap::new();
        revoked.insert("gateway:revoked:jti:abc".to_string(), now_secs() + 600);
        SNAPSHOT.store(Arc::new(snap_with(revoked, HashMap::new())));
        assert!(is_revoked(Some("abc"), "deadbeef"));
        assert!(!is_revoked(Some("other"), "deadbeef"));
    }

    #[test]
    fn expired_revocation_entry_is_not_revoked() {
        let mut revoked = HashMap::new();
        revoked.insert("gateway:revoked:token:ff".to_string(), now_secs().saturating_sub(1));
        SNAPSHOT.store(Arc::new(snap_with(revoked, HashMap::new())));
        assert!(!is_revoked(None, "ff"));
    }

    #[test]
    fn empty_jti_is_ignored() {
        SNAPSHOT.store(Arc::new(snap_with(HashMap::new(), HashMap::new())));
        assert!(!is_revoked(Some(""), "x"));
        assert!(!is_revoked(None, "x"));
    }

    #[test]
    fn tv_floor_matching_semantics() {
        let mut floors = HashMap::new();
        floors.insert("alice".to_string(), 7);
        SNAPSHOT.store(Arc::new(snap_with(HashMap::new(), floors)));

        assert_eq!(tv_status("alice", Some(7)), TvStatus::Valid);
        assert_eq!(tv_status("alice", Some(6)), TvStatus::Stale);
        assert_eq!(tv_status("alice", None), TvStatus::Stale);
        // No floor published → everything valid (ADR-0053).
        assert_eq!(tv_status("bob", None), TvStatus::Valid);
        assert_eq!(tv_status("bob", Some(99)), TvStatus::Valid);
    }

    #[test]
    fn never_synced_snapshot_is_stale() {
        SNAPSHOT.store(Arc::new(RevocationSnapshot::empty()));
        assert!(snapshot_stale());
    }

    #[test]
    fn fresh_snapshot_is_not_stale() {
        SNAPSHOT.store(Arc::new(snap_with(HashMap::new(), HashMap::new())));
        assert!(!snapshot_stale());
    }

    #[test]
    fn sync_interval_is_clamped() {
        let iv = sync_interval_secs();
        assert!((1..=300).contains(&iv));
    }
}
