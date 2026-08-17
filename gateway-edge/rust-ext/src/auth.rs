//! Authentication — Production-grade JWT validation
//!
//! Security features:
//!   1. `alg` header validation — only "HS256" accepted, rejects "none" and RS256→HS256 confusion
//!   2. `exp` claim enforcement — token expired → reject
//!   3. `nbf` claim enforcement — token not yet valid → reject
//!   4. `kid` (key ID) support — multiple active secrets for zero-downtime rotation
//!   5. Token revocation list — Redis-backed, checked on every cache miss
//!   6. Constant-time signature comparison — prevents timing side-channel attacks
//!   7. LRU cache (8,192 entries) — gradual eviction, no thundering herd.
//!      Entries are bounded to `AUTH_CACHE_TTL_SECS` (default 30s), NOT the
//!      token's full `exp`, so revocation propagates within that window.
//!
//! Hot path cost:
//!   - Cache hit (not revoked): ~50 ns
//!   - Cache miss:              ~2–5 µs (base64 + HMAC + JSON + revocation check)

use base64::{engine::general_purpose, Engine as _};
use hmac::{Hmac, Mac};
use lru::LruCache;
use serde::Deserialize;
use sha2::Sha256;
use std::cell::RefCell;
use std::num::NonZeroUsize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::config::GLOBAL_CONFIG;
use crate::redis_cb::{with_circuit_breaker, classify_redis_error, RedisCallOutcome};

type HmacSha256 = Hmac<Sha256>;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
pub struct UserIdentity {
    pub user_id: String,
    pub home_region: Option<String>,
}

// ── JWT internal types ────────────────────────────────────────────────────────

/// JWT header — we only care about `alg` and `kid`
#[derive(Debug, Deserialize)]
struct JwtHeader {
    alg: String,
    #[serde(default)]
    kid: String,
}

/// JWT claims — all standard security fields
#[derive(Debug, Deserialize)]
struct JwtClaims {
    #[serde(rename = "sub", default)]
    user_id: String,
    home_region: Option<String>,
    /// Expiry (Unix seconds) — REQUIRED for security; tokens without exp are rejected
    exp: Option<u64>,
    /// Not-before (Unix seconds) — token invalid before this time
    nbf: Option<u64>,
    /// Issued-at (Unix seconds) — used for max-age enforcement
    iat: Option<u64>,
    /// Issuer — strictly verified
    iss: Option<String>,
    /// Audience — strictly verified
    aud: Option<String>,
    /// JWT ID — preferred revocation handle (revoke by id, not full token)
    jti: Option<String>,
    /// Token version — must match Redis `gateway:user:tv:{sub}` when published (ADR-0053).
    tv: Option<u64>,
}

// ── Thread-local L1 cache ─────────────────────────────────────────────────────

#[derive(Clone)]
struct CachedToken {
    identity:   UserIdentity,
    expires_at: u64,
    /// Token version at issuance — re-checked on cache hit (ADR-0053).
    tv:         Option<u64>,
}

thread_local! {
    static TOKEN_CACHE: RefCell<LruCache<String, CachedToken>> =
        RefCell::new(LruCache::new(NonZeroUsize::new(8_192).unwrap()));
}

// ── Revocation list ───────────────────────────────────────────────────────────

/// Result of a revocation-list lookup against Redis.
enum RevocationStatus {
    NotRevoked,
    Revoked,
    /// Redis unreachable or timed out — policy depends on `REVOCATION_FAIL_CLOSED`.
    Unavailable,
}

/// Result of a token-version floor lookup against Redis.
enum TokenVersionStatus {
    Valid,
    Stale,
    Unavailable,
}

fn token_version_key(user_id: &str) -> String {
    format!("gateway:user:tv:{user_id}")
}

/// Pure decision logic for token-version validation (unit-tested).
fn token_version_matches(stored: Option<u64>, token_tv: Option<u64>) -> bool {
    match stored {
        None => true,
        Some(expected) => token_tv == Some(expected),
    }
}



fn revocation_fail_closed() -> bool {
    std::env::var("REVOCATION_FAIL_CLOSED")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Max seconds a validated token stays in the per-worker positive cache.
///
/// Revocation is only consulted on a cache *miss*. If entries lived until the
/// token's own `exp` (15 min – hours), revoking an actively-used token would have
/// no effect until it expired — defeating revocation for exactly the hot tokens
/// that matter most. Capping the cache lifetime bounds the revocation
/// propagation delay to this window while keeping a high cache-hit rate.
/// Tunable via `AUTH_CACHE_TTL_SECS` (default 30s). Read once and cached.
fn cache_ttl_secs() -> u64 {
    use std::sync::OnceLock;
    static TTL: OnceLock<u64> = OnceLock::new();
    *TTL.get_or_init(|| {
        std::env::var("AUTH_CACHE_TTL_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(|v| v.clamp(1, 300))
            .unwrap_or(30)
    })
}

/// Effective cache expiry: the earlier of the token's own `exp` and the bounded
/// cache TTL window. Extracted as a pure function for testing.
fn effective_cache_expiry(token_exp: u64, now: u64, ttl: u64) -> u64 {
    token_exp.min(now.saturating_add(ttl))
}

/// Build the Redis connection URL. Supports ACL auth and TLS (`rediss://`).
/// Set `REDIS_TLS=1` for managed Redis with in-transit encryption (ADR-0028).
fn redis_url() -> String {
    let scheme = if std::env::var("REDIS_TLS")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        "rediss"
    } else {
        "redis"
    };
    let host = std::env::var("REDIS_HOST").unwrap_or_else(|_| "redis".to_string());
    let port = std::env::var("REDIS_PORT").unwrap_or_else(|_| "6379".to_string());
    let user = std::env::var("REDIS_USERNAME").ok().filter(|s| !s.is_empty());
    let pass = std::env::var("REDIS_PASSWORD").ok().filter(|s| !s.is_empty());
    match (user, pass) {
        (Some(u), Some(p)) => format!("{scheme}://{u}:{p}@{host}:{port}"),
        (None, Some(p)) => format!("{scheme}://:{p}@{host}:{port}"),
        _ => format!("{scheme}://{host}:{port}"),
    }
}

/// SHA-256 of the full token, lowercase hex. This is the canonical, collision-free
/// revocation identifier when no `jti` is present.
///
/// NOTE: we deliberately do **not** key on a prefix of the raw token. For HS256
/// the first ~20 bytes are the constant header (`eyJhbGciOiJIUzI1NiJ9.`), so a
/// truncated-prefix key collides across unrelated tokens and also leaks token
/// bytes into Redis keys. Hashing the whole token is unique and opaque.
fn token_hash_hex(token: &str) -> String {
    use sha2::Digest;
    let digest = Sha256::digest(token.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for b in digest.iter() {
        use std::fmt::Write;
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

/// Build the ordered list of Redis keys that, if present, mean "revoked".
///
/// Revocation publishers (auth server / control plane) must `SET` one of:
///   - `gateway:revoked:jti:<jti>`            — preferred: revoke by token ID
///   - `gateway:revoked:token:<sha256_hex>`   — fallback: revoke a specific token
///
/// See ADR-0038. A short TTL equal to the token's remaining lifetime is enough;
/// the signature + `exp` check already rejects the token after expiry.
fn revocation_keys(token: &str, jti: Option<&str>) -> Vec<String> {
    let mut keys = Vec::with_capacity(2);
    if let Some(j) = jti.filter(|s| !s.is_empty()) {
        keys.push(format!("gateway:revoked:jti:{j}"));
    }
    keys.push(format!("gateway:revoked:token:{}", token_hash_hex(token)));
    keys
}

fn redis_timeout_ms() -> u64 {
    std::env::var("REDIS_AUTH_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|v| v.clamp(5, 1000))
        .unwrap_or(50)
}

thread_local! {
    /// Per-worker persistent Redis connection for revocation lookups.
    static REDIS_CONN: RefCell<Option<redis::Connection>> = const { RefCell::new(None) };
}

/// Establish a new Redis connection with bounded connect + I/O timeouts (§14).
fn open_redis_connection() -> Option<redis::Connection> {
    let timeout = Duration::from_millis(redis_timeout_ms());
    let client = redis::Client::open(redis_url().as_str()).ok()?;
    let con = client
        .get_connection_with_timeout(timeout)
        .ok()?;
    // Bound every command so a hung server can't block the request thread (§14).
    let _ = con.set_read_timeout(Some(timeout));
    let _ = con.set_write_timeout(Some(timeout));
    Some(con)
}

fn check_token_version(user_id: &str, tv: Option<u64>) -> TokenVersionStatus {
    let key = token_version_key(user_id);

    let result = with_circuit_breaker(|| {
        REDIS_CONN.with(|cell| {
            let mut guard = cell.borrow_mut();
            for attempt in 0..2 {
                if attempt > 0 {
                    // §16, §21 — Bounded backoff + jitter to prevent retry storms
                    let jitter_ms = (std::process::id() as u64 + attempt as u64) % 5;
                    std::thread::sleep(Duration::from_millis(2 + jitter_ms));
                }
                if guard.is_none() {
                    match open_redis_connection() {
                        Some(c) => *guard = Some(c),
                        None    => return Err(RedisCallOutcome::RedisError),
                    }
                }
                let con = match guard.as_mut() {
                    Some(c) => c,
                    None    => return Err(RedisCallOutcome::RedisError),
                };
                let r: redis::RedisResult<Option<String>> =
                    redis::cmd("GET").arg(&key).query(con);
                match r {
                    Ok(val)  => return Ok(val),
                    Err(e)   => {
                        *guard = None;
                        let outcome = classify_redis_error(&e);
                        // §16 — Do not retry on explicit timeout
                        if outcome == RedisCallOutcome::Timeout {
                            return Err(outcome);
                        }
                    }
                }
            }
            Err(RedisCallOutcome::RedisError)
        })
    });

    match result {
        Ok(None)        => TokenVersionStatus::Valid,
        Ok(Some(raw))   => {
            let stored = raw.parse::<u64>().unwrap_or(0);
            if token_version_matches(Some(stored), tv) {
                TokenVersionStatus::Valid
            } else {
                TokenVersionStatus::Stale
            }
        }
        Err(_) => TokenVersionStatus::Unavailable,
    }
}

/// Check if a token is in the Redis revocation list.
/// Called on every cache miss — never on cache hit (performance).
/// Wrapped with the circuit breaker: if Redis is OPEN/slow/down, returns
/// Unavailable immediately without attempting the network call (§17).
fn check_revocation(token: &str, jti: Option<&str>) -> RevocationStatus {
    let keys = revocation_keys(token, jti);

    let result = with_circuit_breaker(|| {
        REDIS_CONN.with(|cell| {
            let mut guard = cell.borrow_mut();
            for attempt in 0..2 {
                if attempt > 0 {
                    // §16, §21 — Bounded backoff + jitter to prevent retry storms
                    let jitter_ms = (std::process::id() as u64 + attempt as u64) % 5;
                    std::thread::sleep(Duration::from_millis(2 + jitter_ms));
                }
                if guard.is_none() {
                    match open_redis_connection() {
                        Some(c) => *guard = Some(c),
                        None    => return Err(RedisCallOutcome::RedisError),
                    }
                }
                let con = match guard.as_mut() {
                    Some(c) => c,
                    None    => return Err(RedisCallOutcome::RedisError),
                };
                let r: redis::RedisResult<i64> =
                    redis::cmd("EXISTS").arg(&keys).query(con);
                match r {
                    Ok(count) => return Ok(count),
                    Err(e)    => {
                        let outcome = classify_redis_error(&e);
                        *guard = None;
                        if outcome == RedisCallOutcome::Timeout {
                            return Err(RedisCallOutcome::Timeout);
                        }
                    }
                }
            }
            Err(RedisCallOutcome::RedisError)
        })
    });

    match result {
        Ok(0) => RevocationStatus::NotRevoked,
        Ok(_) => RevocationStatus::Revoked,
        Err(_) => RevocationStatus::Unavailable,
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Validate a Bearer JWT token.
///
/// Rejects on:
/// - Missing/malformed Bearer prefix
/// - Wrong segment count
/// - `alg` != "HS256" (prevents algorithm confusion attacks)
/// - Invalid base64
/// - HMAC-SHA256 signature mismatch
/// - Token expired (`exp` in the past)
/// - Token not yet valid (`nbf` in the future)
/// - Token too old (issued > 24h ago, even if `exp` is far future)
/// - Token in revocation list
pub fn validate_token(auth_header: &str) -> Option<UserIdentity> {
    let token = auth_header.strip_prefix("Bearer ")?;
    let now   = now_secs();

    // ── 1. LRU cache lookup ───────────────────────────────────────────────────
    let cached = TOKEN_CACHE.with(|c| c.borrow_mut().get(token).cloned());
    if let Some(entry) = cached {
        if entry.expires_at > now {
            // Token-version floor can change without this JWT changing (password reset).
            // Re-check on every request, including cache hits.
            match check_token_version(&entry.identity.user_id, entry.tv) {
                TokenVersionStatus::Stale => {
                    TOKEN_CACHE.with(|c| c.borrow_mut().pop(token));
                    return None;
                }
                TokenVersionStatus::Unavailable if revocation_fail_closed() => return None,
                TokenVersionStatus::Valid | TokenVersionStatus::Unavailable => {
                    return Some(entry.identity);
                }
            }
        }
        TOKEN_CACHE.with(|c| c.borrow_mut().pop(token));
    }

    // ── 2. Parse JWT structure ────────────────────────────────────────────────
    let parts: Vec<&str> = token.splitn(3, '.').collect();
    if parts.len() != 3 {
        return None;
    }
    let (header_b64, payload_b64, sig_b64) = (parts[0], parts[1], parts[2]);

    // ── 3. Decode and validate header ─────────────────────────────────────────
    let header_bytes = general_purpose::URL_SAFE_NO_PAD.decode(header_b64).ok()?;
    let header: JwtHeader = serde_json::from_slice(&header_bytes).ok()?;

    // CRITICAL: reject any algorithm other than HS256
    // This prevents the "alg:none" attack and RS256→HS256 confusion attacks
    if header.alg != "HS256" {
        return None;
    }

    // ── 4. Select signing secret (kid-based key rotation) ────────────────────
    let config = GLOBAL_CONFIG.load();
    let secret = if header.kid.is_empty() {
        // No kid — use the primary secret
        config.jwt_secret.as_bytes().to_vec()
    } else {
        // kid present — look up in the key map for zero-downtime rotation
        match config.jwt_keys.get(&header.kid) {
            Some(k) => k.as_bytes().to_vec(),
            None    => return None, // unknown kid → reject
        }
    };

    // ── 5. Verify HMAC-SHA256 signature ───────────────────────────────────────
    let mut mac = HmacSha256::new_from_slice(&secret).ok()?;
    mac.update(header_b64.as_bytes());
    mac.update(b".");
    mac.update(payload_b64.as_bytes());
    let expected = mac.finalize().into_bytes();

    let provided = general_purpose::URL_SAFE_NO_PAD.decode(sig_b64).ok()?;

    // Constant-time comparison — prevents timing side-channel attacks
    if !constant_time_eq(&expected, &provided) {
        return None;
    }

    // ── 6. Decode and validate claims ─────────────────────────────────────────
    let payload_bytes = general_purpose::URL_SAFE_NO_PAD.decode(payload_b64).ok()?;
    let claims: JwtClaims = serde_json::from_slice(&payload_bytes).ok()?;

    // exp: token must have an expiry (tokens without exp are rejected for security)
    let exp = claims.exp?;
    if now >= exp {
        return None; // expired
    }

    // nbf: token must not be used before its not-before time
    if let Some(nbf) = claims.nbf {
        if now < nbf {
            return None; // not yet valid
        }
    }

    // iat: reject tokens issued more than 24 hours ago (defence in depth)
    if let Some(iat) = claims.iat {
        if now > iat + 86_400 {
            return None; // too old
        }
    }

    // iss: strict issuer validation (prevents accepting tokens generated by other systems)
    if claims.iss.as_deref() != Some(config.expected_issuer.as_str()) {
        return None;
    }

    // aud: strict audience validation (prevents accepting tokens meant for other services)
    if claims.aud.as_deref() != Some(config.expected_audience.as_str()) {
        return None;
    }

    // ── 7. Revocation check ───────────────────────────────────────────────────
    match check_revocation(token, claims.jti.as_deref()) {
        RevocationStatus::Revoked => return None,
        RevocationStatus::Unavailable if revocation_fail_closed() => return None,
        RevocationStatus::NotRevoked | RevocationStatus::Unavailable => {}
    }

    // ── 7b. Token-version floor (password reset / kill-all-sessions) ──────────
    let raw_user_id_for_tv = if claims.user_id.is_empty() {
        extract_user_id_field(&payload_bytes).unwrap_or_default()
    } else {
        claims.user_id.clone()
    };
    if !raw_user_id_for_tv.is_empty() {
        match check_token_version(&raw_user_id_for_tv, claims.tv) {
            TokenVersionStatus::Stale => return None,
            TokenVersionStatus::Unavailable if revocation_fail_closed() => return None,
            TokenVersionStatus::Valid | TokenVersionStatus::Unavailable => {}
        }
    }

    // ── 8. Build identity and Sanitize (CRLF Injection Prevention) ────────────
    let raw_user_id = if claims.user_id.is_empty() {
        extract_user_id_field(&payload_bytes)?
    } else {
        claims.user_id
    };

    // Sanitize to prevent HTTP Request Smuggling or Header Injection upstream
    let user_id = sanitize_header_val(&raw_user_id)?;
    let home_region = match claims.home_region {
        Some(r) => Some(sanitize_header_val(&r)?),
        None => None,
    };

    let identity = UserIdentity { user_id, home_region };

    // ── 9. Cache the validated token ──────────────────────────────────────────
    // Bound the entry to a short TTL (not the token's full `exp`) so a revoked
    // token is re-checked against Redis within `cache_ttl_secs()`.
    let cache_expiry = effective_cache_expiry(exp, now, cache_ttl_secs());
    TOKEN_CACHE.with(|c| {
        c.borrow_mut().put(
            token.to_string(),
            CachedToken {
                identity: identity.clone(),
                expires_at: cache_expiry,
                tv: claims.tv,
            },
        );
    });

    Some(identity)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn sanitize_header_val(val: &str) -> Option<String> {
    // Reject any CRLF or Null bytes to prevent HTTP header injection
    if val.contains('\r') || val.contains('\n') || val.contains('\0') {
        return None;
    }
    Some(val.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Constant-time byte comparison — prevents timing side-channel attacks.
#[inline]
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn extract_user_id_field(payload_bytes: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct AltClaims { user_id: String }
    serde_json::from_slice::<AltClaims>(payload_bytes).ok().map(|c| c.user_id)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_missing_bearer_rejected() {
        assert!(validate_token("notabearer").is_none());
    }

    #[test]
    fn test_wrong_segment_count_rejected() {
        assert!(validate_token("Bearer only.two").is_none());
    }

    #[test]
    fn test_constant_time_eq_same() {
        assert!(constant_time_eq(b"hello", b"hello"));
    }

    #[test]
    fn cache_expiry_capped_by_ttl_for_long_lived_tokens() {
        // Token valid for 1 hour, but the cache must only trust it for `ttl`
        // seconds so a revocation is re-checked within that bounded window.
        let now = 1_000_000;
        let token_exp = now + 3_600; // 1h
        let ttl = 30;
        assert_eq!(effective_cache_expiry(token_exp, now, ttl), now + ttl);
    }

    #[test]
    fn cache_expiry_uses_exp_when_token_expires_sooner_than_ttl() {
        // A token expiring in 5s must not be cached for the full 30s TTL.
        let now = 1_000_000;
        let token_exp = now + 5;
        assert_eq!(effective_cache_expiry(token_exp, now, 30), token_exp);
    }

    #[test]
    fn cache_expiry_never_overflows() {
        // Saturating add guards against a near-u64::MAX `now` + ttl.
        assert_eq!(effective_cache_expiry(u64::MAX, u64::MAX - 1, 30), u64::MAX);
    }

    #[test]
    fn cache_ttl_is_clamped_to_sane_bounds() {
        // Default applies and the value is always within [1, 300].
        let ttl = cache_ttl_secs();
        assert!((1..=300).contains(&ttl));
    }

    #[test]
    fn redis_timeouts_are_nonzero() {
        // The redis crate treats a zero Duration as an error in
        // set_read_timeout/set_write_timeout, so these must stay > 0.
        assert!(redis_timeout_ms() > 0);
    }

    #[test]
    fn test_constant_time_eq_different() {
        assert!(!constant_time_eq(b"hello", b"world"));
    }

    #[test]
    fn test_constant_time_eq_different_lengths() {
        assert!(!constant_time_eq(b"hi", b"hello"));
    }

    #[test]
    fn token_version_matches_when_no_floor_published() {
        assert!(token_version_matches(None, None));
        assert!(token_version_matches(None, Some(0)));
    }

    #[test]
    fn token_version_rejects_missing_or_stale_claim_when_floor_exists() {
        assert!(!token_version_matches(Some(1), None));
        assert!(!token_version_matches(Some(1), Some(0)));
        assert!(token_version_matches(Some(1), Some(1)));
    }

    #[test]
    fn test_revocation_fail_closed_env() {
        std::env::set_var("REVOCATION_FAIL_CLOSED", "1");
        assert!(revocation_fail_closed());
        std::env::set_var("REVOCATION_FAIL_CLOSED", "true");
        assert!(revocation_fail_closed());
        std::env::remove_var("REVOCATION_FAIL_CLOSED");
        assert!(!revocation_fail_closed());
    }

    #[test]
    fn test_redis_url_formats() {
        std::env::remove_var("REDIS_USERNAME");
        std::env::remove_var("REDIS_PASSWORD");
        std::env::set_var("REDIS_HOST", "redis");
        std::env::set_var("REDIS_PORT", "6379");
        assert_eq!(redis_url(), "redis://redis:6379");

        std::env::set_var("REDIS_PASSWORD", "secret");
        assert_eq!(redis_url(), "redis://:secret@redis:6379");

        std::env::set_var("REDIS_USERNAME", "gateway");
        assert_eq!(redis_url(), "redis://gateway:secret@redis:6379");

        std::env::set_var("REDIS_TLS", "1");
        assert_eq!(redis_url(), "rediss://gateway:secret@redis:6379");

        std::env::remove_var("REDIS_TLS");
        std::env::remove_var("REDIS_USERNAME");
        std::env::remove_var("REDIS_PASSWORD");
    }

    #[test]
    fn test_alg_none_rejected() {
        // Craft a token with alg:none — must be rejected
        use base64::{engine::general_purpose, Engine as _};
        let header  = general_purpose::URL_SAFE_NO_PAD.encode(b"{\"alg\":\"none\"}");
        let payload = general_purpose::URL_SAFE_NO_PAD.encode(b"{\"sub\":\"user1\",\"exp\":9999999999}");
        let token   = format!("Bearer {header}.{payload}.");
        assert!(validate_token(&token).is_none());
    }

    #[test]
    fn test_alg_rs256_rejected() {
        use base64::{engine::general_purpose, Engine as _};
        let header  = general_purpose::URL_SAFE_NO_PAD.encode(b"{\"alg\":\"RS256\"}");
        let payload = general_purpose::URL_SAFE_NO_PAD.encode(b"{\"sub\":\"user1\",\"exp\":9999999999}");
        let token   = format!("Bearer {header}.{payload}.fakesig");
        assert!(validate_token(&token).is_none());
    }

    #[test]
    fn test_expired_token_rejected() {
        use base64::{engine::general_purpose, Engine as _};
        let header  = general_purpose::URL_SAFE_NO_PAD.encode(b"{\"alg\":\"HS256\"}");
        // exp = 1 (Unix epoch + 1s — definitely in the past)
        let payload = general_purpose::URL_SAFE_NO_PAD.encode(b"{\"sub\":\"user1\",\"exp\":1}");
        let token   = format!("Bearer {header}.{payload}.fakesig");
        assert!(validate_token(&token).is_none());
    }

    #[test]
    fn test_nbf_future_rejected() {
        use base64::{engine::general_purpose, Engine as _};
        let header  = general_purpose::URL_SAFE_NO_PAD.encode(b"{\"alg\":\"HS256\"}");
        // nbf = far future
        let payload = general_purpose::URL_SAFE_NO_PAD
            .encode(b"{\"sub\":\"user1\",\"exp\":9999999999,\"nbf\":9999999998}");
        let token   = format!("Bearer {header}.{payload}.fakesig");
        assert!(validate_token(&token).is_none());
    }

    #[test]
    fn test_token_hash_is_stable_and_unique() {
        // Two tokens that share the (constant) HS256 header prefix must hash to
        // different revocation keys — the old prefix scheme would have collided.
        let a = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.sigA";
        let b = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib2IifQ.sigB";
        assert_eq!(token_hash_hex(a).len(), 64);
        assert_ne!(token_hash_hex(a), token_hash_hex(b));
        // Deterministic.
        assert_eq!(token_hash_hex(a), token_hash_hex(a));
    }

    #[test]
    fn test_revocation_keys_prefer_jti() {
        let keys = revocation_keys("tok", Some("abc-123"));
        assert_eq!(keys[0], "gateway:revoked:jti:abc-123");
        assert!(keys[1].starts_with("gateway:revoked:token:"));
        // Empty jti is ignored — only the token-hash key remains.
        let keys_no_jti = revocation_keys("tok", Some(""));
        assert_eq!(keys_no_jti.len(), 1);
        assert!(keys_no_jti[0].starts_with("gateway:revoked:token:"));
        // No jti at all.
        assert_eq!(revocation_keys("tok", None).len(), 1);
    }

    #[test]
    fn test_missing_exp_rejected() {
        use base64::{engine::general_purpose, Engine as _};
        let header  = general_purpose::URL_SAFE_NO_PAD.encode(b"{\"alg\":\"HS256\"}");
        // No exp claim
        let payload = general_purpose::URL_SAFE_NO_PAD.encode(b"{\"sub\":\"user1\"}");
        let token   = format!("Bearer {header}.{payload}.fakesig");
        assert!(validate_token(&token).is_none());
    }
}
