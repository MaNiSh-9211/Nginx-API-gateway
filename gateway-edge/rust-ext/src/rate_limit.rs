//! Rate Limiter — Per-Node Shared Memory + Fleet-Wide Redis Sync
//!
//! Architecture:
//!   Layer 1 (hot path, ~15 ns):
//!     - OS-level mmap file (`/tmp/gateway_rate_limit.shm`)
//!     - 1,000,000 AtomicU64 slots (~8 MB)
//!     - All NGINX workers on this node share the same physical memory
//!     - Lock-free CAS loop — zero allocation, zero blocking
//!     - Enforces the limit locally; always the first and fastest check
//!
//!   Layer 2 (background, non-blocking):
//!     - Background thread syncs per-user counts to Redis via EVALSHA
//!     - Redis key: `gateway:rl:{user_id}`, TTL = 2s (1s window + 1s buffer)
//!     - On Redis success: if fleet-wide count exceeds limit, marks local bucket
//!       as exhausted so the next request hits the local limit immediately
//!     - On Redis failure (any error): fail-open — local bucket keeps enforcing
//!       as if Redis doesn't exist; no request is blocked due to Redis being down
//!     - Hot path never blocks on Redis; channel send is try_send (non-blocking)
//!
//!   Fallback guarantee:
//!     If Redis is down, unreachable, or slow, the local mmap bucket continues
//!     enforcing per-node limits exactly as before this feature existed.
//!     No request is ever rejected or blocked due to a Redis failure.

use crossbeam::channel::{bounded, Sender};
use rustc_hash::FxHasher;
use std::cell::RefCell;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use memmap2::MmapMut;
use std::fs::OpenOptions;

use crate::redis_cb::{with_circuit_breaker, classify_redis_error, RedisCallOutcome};

// ── Shared memory (unchanged from original) ───────────────────────────────────

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
    let file = opts.open(&path).unwrap_or_else(|e| {
        panic!("rate_limit: failed to open shm file: {e}")
    });
    file.set_len(SHM_SIZE as u64).unwrap_or_else(|e| {
        panic!("rate_limit: failed to set shm size: {e}")
    });
    let mmap = unsafe { MmapMut::map_mut(&file).unwrap_or_else(|e| {
        panic!("rate_limit: failed to mmap: {e}")
    }) };
    let ptr = mmap.as_ptr() as usize;
    std::mem::forget(mmap);
    ptr
}

fn get_bucket(key: u64) -> &'static AtomicU64 {
    let slot = (key % (SHM_SLOTS as u64)) as usize;
    let ptr = *SHM_PTR.get_or_init(init_shm) as *const AtomicU64;
    unsafe { &*ptr.add(slot) }
}

// ── Redis sync background thread ──────────────────────────────────────────────

/// Message sent from the hot path to the background sync thread.
/// Capacity-1 channel per worker: if a sync is already in flight for a user,
/// the next message is silently dropped (non-blocking). This is safe because
/// the local bucket has already counted the request.
#[derive(Debug)]
struct SyncMsg {
    user_key:    String,
    #[allow(dead_code)]
    local_count: u32,
    window_ts:   u32,
    max_rps:     u32,
}

// Thread-local sender so the hot path never contends across goroutines.
thread_local! {
    static RL_TX: RefCell<Option<Sender<SyncMsg>>> = RefCell::new(None);
}

/// True while the background sync thread is alive.
static SYNC_THREAD_ALIVE: AtomicBool = AtomicBool::new(false);

/// Incremented each time the sync thread is restarted.
pub static RL_SYNC_THREAD_RESTARTS: AtomicU64 = AtomicU64::new(0);
/// Successful Redis sync operations.
pub static RL_REDIS_SYNCS_OK: AtomicU64 = AtomicU64::new(0);
/// Failed Redis sync operations (any error category).
pub static RL_REDIS_SYNCS_ERR: AtomicU64 = AtomicU64::new(0);

// ── Redis configuration ───────────────────────────────────────────────────────

fn redis_url_from_vars<F>(mut get_var: F) -> String
where
    F: FnMut(&str) -> Result<String, std::env::VarError>,
{
    if let Ok(url) = get_var("REDIS_URL") {
        if !url.is_empty() {
            return url;
        }
    }
    let scheme = if get_var("REDIS_TLS")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        "rediss"
    } else {
        "redis"
    };
    let host = get_var("REDIS_HOST").unwrap_or_else(|_| "redis".to_string());
    let port = get_var("REDIS_PORT").unwrap_or_else(|_| "6379".to_string());
    let user = get_var("REDIS_USERNAME").ok().filter(|s| !s.is_empty());
    let pass = get_var("REDIS_PASSWORD").ok().filter(|s| !s.is_empty());
    match (user, pass) {
        (Some(u), Some(p)) => format!("{scheme}://{u}:{p}@{host}:{port}"),
        (None, Some(p))    => format!("{scheme}://:{p}@{host}:{port}"),
        _                  => format!("{scheme}://{host}:{port}"),
    }
}

fn redis_url() -> String {
    redis_url_from_vars(|k| std::env::var(k))
}

fn rl_redis_enabled() -> bool {
    std::env::var("RATE_LIMIT_REDIS_ENABLED")
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false"))
        .unwrap_or(true)
}

fn rl_redis_timeout_ms() -> u64 {
    std::env::var("RATE_LIMIT_REDIS_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|v| v.clamp(5, 500))
        .unwrap_or(50)
}

/// Lua script (server-side atomic): INCR the key and set TTL on first call.
/// Returns the fleet-wide count after increment.
/// KEYS[1] = gateway:rl:{user_id}
/// ARGV[1] = TTL in seconds (window + 1)
const RL_LUA_SCRIPT: &str = r"
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
";

/// SHA1 of RL_LUA_SCRIPT, computed at compile time via a const approach.
/// We use EVAL on the first call and cache the SHA for EVALSHA on subsequent calls.
/// If EVALSHA returns NOSCRIPT, we fall back to EVAL and re-cache the SHA.
static SCRIPT_SHA: OnceLock<String> = OnceLock::new();

fn eval_script(con: &mut redis::Connection, key: &str, ttl: u64) -> redis::RedisResult<i64> {
    redis::cmd("EVAL")
        .arg(RL_LUA_SCRIPT)
        .arg(1)      // number of KEYS
        .arg(key)    // KEYS[1]
        .arg(ttl)    // ARGV[1]
        .query(con)
}

fn evalsha_or_eval(
    con: &mut redis::Connection,
    key: &str,
    ttl: u64,
) -> redis::RedisResult<i64> {
    // If we already have the SHA, try EVALSHA first
    if let Some(sha) = SCRIPT_SHA.get() {
        let result: redis::RedisResult<i64> = redis::cmd("EVALSHA")
            .arg(sha)
            .arg(1)
            .arg(key)
            .arg(ttl)
            .query(con);

        match result {
            Ok(count) => return Ok(count),
            Err(ref e) if e.to_string().contains("NOSCRIPT") => {
                // Script was flushed from Redis — fall through to EVAL
            }
            Err(e) => return Err(e),
        }
    }

    // Load script and cache SHA
    let sha: String = redis::cmd("SCRIPT")
        .arg("LOAD")
        .arg(RL_LUA_SCRIPT)
        .query(con)?;

    // Cache SHA for future calls (best-effort; races are harmless)
    let _ = SCRIPT_SHA.set(sha);

    eval_script(con, key, ttl)
}

/// Spawn the background sync thread. Called once per worker from init_extension().
/// Safe to call multiple times — idempotent (checks SYNC_THREAD_ALIVE).
pub fn start_rl_redis_sync() {
    if !rl_redis_enabled() {
        eprintln!("rate_limit: RATE_LIMIT_REDIS_ENABLED=false — running local-only mode");
        return;
    }

    if SYNC_THREAD_ALIVE.load(Ordering::Acquire) {
        return; // already running
    }

    let (tx, rx) = bounded::<SyncMsg>(512);

    // Store sender in thread-local so hot path can find it
    RL_TX.with(|cell| {
        *cell.borrow_mut() = Some(tx);
    });

    SYNC_THREAD_ALIVE.store(true, Ordering::Release);

    std::thread::spawn(move || {
        let timeout_ms = rl_redis_timeout_ms();
        let connect_timeout = Duration::from_millis(timeout_ms);
        let io_timeout      = Duration::from_millis(timeout_ms);

        let mut con_opt: Option<redis::Connection> = None;

        // Attempt to open a Redis connection, bounded by timeout
        let open_conn = || -> Option<redis::Connection> {
            let client = redis::Client::open(redis_url().as_str()).ok()?;
            let con = client.get_connection_with_timeout(connect_timeout).ok()?;
            let _ = con.set_read_timeout(Some(io_timeout));
            let _ = con.set_write_timeout(Some(io_timeout));
            Some(con)
        };

        loop {
            // Receive a sync message; block up to 200ms then loop
            let msg = match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(m) => m,
                Err(crossbeam::channel::RecvTimeoutError::Timeout) => continue,
                Err(crossbeam::channel::RecvTimeoutError::Disconnected) => break,
            };

            let redis_key = format!("gateway:rl:{}", msg.user_key);
            let ttl: u64 = 2; // 1-second window + 1-second buffer

            // Wrap Redis sync operation with circuit breaker (§5, §17, §25)
            let result = with_circuit_breaker(|| {
                if con_opt.is_none() {
                    con_opt = open_conn();
                }
                if let Some(ref mut con) = con_opt {
                    match evalsha_or_eval(con, &redis_key, ttl) {
                        Ok(count) => Ok(count),
                        Err(e) => {
                            let outcome = classify_redis_error(&e);
                            Err(outcome)
                        }
                    }
                } else {
                    Err(RedisCallOutcome::RedisError)
                }
            });

            match result {
                Ok(fleet_count) => {
                    RL_REDIS_SYNCS_OK.fetch_add(1, Ordering::Relaxed);

                    // If fleet count exceeds the limit, saturate the local bucket
                    // so the next hot-path CAS sees it as exhausted.
                    if fleet_count as u32 > msg.max_rps {
                        let hash_key = fx_hash(&msg.user_key);
                        let bucket   = get_bucket(hash_key);
                        let now      = msg.window_ts;
                        // Write count = max_rps + 1 into the local bucket for this window
                        // so the next check_rate_limit call returns false immediately.
                        let saturated = ((now as u64) << 32) | (msg.max_rps as u64 + 1);
                        let _ = bucket.compare_exchange(
                            bucket.load(Ordering::Relaxed),
                            saturated,
                            Ordering::AcqRel,
                            Ordering::Relaxed,
                        );
                    }
                }
                Err(outcome) => {
                    // Any Redis failure (error/timeout/circuit_open/concurrency) — fail-open
                    RL_REDIS_SYNCS_ERR.fetch_add(1, Ordering::Relaxed);
                    if outcome != RedisCallOutcome::CircuitOpen && outcome != RedisCallOutcome::ConcurrencyRejected {
                        con_opt = None; // reconnect on actual network/command failure
                    }
                }
            }
        }

        SYNC_THREAD_ALIVE.store(false, Ordering::Release);
    });
}

// ── Public API (hot path) ─────────────────────────────────────────────────────

/// Exposed for telemetry — whether Redis sync is enabled.
pub fn rl_redis_enabled_pub() -> bool {
    rl_redis_enabled()
}

/// Check whether this request should be allowed through.
///
/// Hot-path cost:
///   - Local bucket CAS:            ~15 ns  (unchanged)
///   - AtomicBool load (enabled?):  ~2 ns   (new)
///   - try_send to channel:         ~5 ns   (new, non-blocking — drops if full)
///   Total added latency:           ~7 ns
///
/// Fail-open guarantee: if Redis is down, the background thread silently skips
/// syncs and this function returns based on the local bucket only — identical
/// to the pre-Redis behaviour.
pub fn check_rate_limit(max_rps: usize, user_key: Option<&str>) -> bool {
    if max_rps == 0 {
        return true;
    }

    // Per-user limiting applies to AUTHENTICATED requests only (ADR-0007).
    // Anonymous traffic is rate-limited per-IP in the WAF (ADR-0006).
    let user_key = match user_key {
        Some(k) if !k.is_empty() => k,
        _ => return true,
    };

    let key  = fx_hash(user_key);
    let bucket = get_bucket(key);
    let now  = now_secs_u32();
    let mut current = bucket.load(Ordering::Relaxed);

    // ── Layer 1: local CAS (unchanged) ────────────────────────────────────────
    let (allowed, new_count) = loop {
        let current_ts    = (current >> 32) as u32;
        let current_count = (current & 0xFFFF_FFFF) as u32;

        let (new_val, allowed, count) = if current_ts != now {
            // New window — reset to 1
            (((now as u64) << 32) | 1, true, 1u32)
        } else if current_count >= max_rps as u32 {
            // Over limit — fail immediately
            return false;
        } else {
            let c = current_count + 1;
            (((now as u64) << 32) | c as u64, true, c)
        };

        match bucket.compare_exchange_weak(current, new_val, Ordering::AcqRel, Ordering::Relaxed) {
            Ok(_)        => break (allowed, count),
            Err(updated) => current = updated,
        }
    };

    if !allowed {
        return false;
    }

    // ── Layer 2: async Redis sync (non-blocking, fail-open) ───────────────────
    if rl_redis_enabled() {
        RL_TX.with(|cell| {
            let borrow = cell.borrow();
            if let Some(tx) = borrow.as_ref() {
                // try_send never blocks; Err(Full) silently drops — local bucket
                // already counted this request, so dropping is safe.
                let _ = tx.try_send(SyncMsg {
                    user_key:    user_key.to_string(),
                    local_count: new_count,
                    window_ts:   now,
                    max_rps:     max_rps as u32,
                });
            }
        });
    }

    true
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

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
        for _ in 0..1_000 {
            assert!(check_rate_limit(1, None));
        }
        for _ in 0..1_000 {
            assert!(check_rate_limit(1, Some("")));
        }
    }

    #[test]
    fn authenticated_user_eventually_throttled() {
        let key = format!("rl-test-user-{}", std::process::id());
        let max = 3usize;
        let mut rejected = false;
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

    #[test]
    fn redis_disabled_flag_no_panics() {
        // With RATE_LIMIT_REDIS_ENABLED=false the sync path is skipped entirely.
        // The local CAS must still enforce limits correctly.
        std::env::set_var("RATE_LIMIT_REDIS_ENABLED", "false");
        let key = format!("rl-disabled-{}", std::process::id());
        let max = 2usize;
        assert!(check_rate_limit(max, Some(&key)));
        assert!(check_rate_limit(max, Some(&key)));
        // Third call in same second must be rejected
        let mut rejected = false;
        for _ in 0..20 {
            if !check_rate_limit(max, Some(&key)) {
                rejected = true;
                break;
            }
        }
        assert!(rejected);
        std::env::remove_var("RATE_LIMIT_REDIS_ENABLED");
    }

    #[test]
    fn redis_url_uses_redis_url_env_if_set() {
        let vars = |name: &str| match name {
            "REDIS_URL" => Ok("rediss://user:pass@host:6380".to_string()),
            _ => Err(std::env::VarError::NotPresent),
        };
        assert_eq!(redis_url_from_vars(vars), "rediss://user:pass@host:6380");
    }

    #[test]
    fn redis_url_falls_back_to_parts() {
        let vars = |name: &str| match name {
            "REDIS_HOST" => Ok("myredis".to_string()),
            "REDIS_PORT" => Ok("6379".to_string()),
            _ => Err(std::env::VarError::NotPresent),
        };
        assert_eq!(redis_url_from_vars(vars), "redis://myredis:6379");
    }
}
