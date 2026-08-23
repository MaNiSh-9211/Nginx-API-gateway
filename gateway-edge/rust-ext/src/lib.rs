//! Gateway FFI Entrypoint — Ultra-Scale API Gateway v0.7
//!
//! Hot-path execution order (per request, total ~300–600 ns):
//!   1. backpressure::acquire()          — fail-fast if overloaded       (~5 ns)
//!   2. waf::inspect()                   — URI + body + IP rate limit    (~200 ns)
//!   3. auth::validate_token()           — alg/nbf/kid/revocation + LRU  (~50 ns cached)
//!   4. router::route_request()          — path match + data residency   (~10 ns)
//!   5. rate_limit::check_rate_limit()   — local bucket + async Redis    (~20 ns)
//!   6. load_balancing::select_upstream() — P2C + consistent hash + EMA   (~20 ns)
//!   7. write_c_string()                 — fill output buffers           (~5 ns)
//!
//! New in v0.7:
//!   - Distributed rate limiting: Redis EVALSHA fleet-wide counter sync
//!   - Fail-open: Redis failure → local mmap bucket enforces (no request blocked)
//!   - REDIS_URL env var support (Upstash full-URL format)
//!   - New Prometheus metrics: rl_redis_syncs, rl_redis_sync_errors, rl_restarts

mod auth;
mod backpressure;
mod cache;
pub mod config;
pub mod cors;
pub mod health;
mod load_balancing;
pub mod otlp;
mod quota;
mod rate_limit;
pub mod redis_cb;
pub mod revocation;
mod router;
pub mod telemetry;
mod validate;
mod waf;

/// FFI: packed CORS headers for this request's Origin ('' = deny/disabled).
/// # Safety
/// `origin_ptr` must be a valid C string or NULL; `buf` writable for `len`.
#[no_mangle]
pub unsafe extern "C" fn get_cors_headers(
    origin_ptr: *const c_char,
    buf: *mut c_char,
    len: usize,
) -> i32 {
    if buf.is_null() || len == 0 {
        return 0;
    }
    let origin = if origin_ptr.is_null() {
        ""
    } else {
        std::str::from_utf8(CStr::from_ptr(origin_ptr).to_bytes()).unwrap_or("")
    };
    let packed = cors::packed_headers(origin);
    write_c_string(&packed, buf, len);
    packed.len().min(len.saturating_sub(1)) as i32
}

// Re-export for external consumers / tests.
pub use load_balancing::circuit_breaker;

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use waf::WafDecision;

// ── Request ID counter ────────────────────────────────────────────────────────

/// Monotonic per-worker request counter for X-Request-ID generation
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Insecure secret warning deduplication: prints at most once per worker process
static INSECURE_WARNING_PRINTED: OnceLock<()> = OnceLock::new();

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/// Called once per NGINX worker process during startup.
#[no_mangle]
pub extern "C" fn init_extension() {
    warn_insecure_secrets();
    config::start_config_sync();
    telemetry::start_telemetry_sync();
    rate_limit::start_rl_redis_sync();
    revocation::start_sync();
    health::start_active_checks();
    otlp::start();
}

/// Log a loud warning when known dev/default secrets are in use.
/// Set `GATEWAY_REFUSE_INSECURE_SECRETS=1` to abort worker startup in prod.
fn warn_insecure_secrets() {
    let _ = INSECURE_WARNING_PRINTED.get_or_init(|| {
        const DEV_SECRETS: &[&str] = &[
            "super_secret_key_for_hmac_sha256_change_in_prod",
            "super_secret_key_for_hmac_sha256",
            "default_secret",
            "change_me_use_a_long_random_secret_at_least_32_chars",
        ];
        let secret = std::env::var("JWT_SECRET").unwrap_or_default();
        let insecure = secret.is_empty()
            || DEV_SECRETS.iter().any(|d| secret == *d);
        if !insecure {
            return;
        }
        eprintln!(
            "gateway: WARNING — JWT_SECRET is empty or a known dev/default value; \
             rotate before production (ADR-0013, ADR-0041)"
        );
        if std::env::var("GATEWAY_REFUSE_INSECURE_SECRETS")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
        {
            eprintln!("gateway: FATAL — GATEWAY_REFUSE_INSECURE_SECRETS=1 and JWT_SECRET is insecure");
            std::process::abort();
        }
    });
}

/// Called after each request from NGINX `log_by_lua_block`.
///
/// Records metrics and updates circuit-breaker / load-balancer state.
///
/// NOTE: This does **not** release the backpressure slot. Slot lifecycle is
/// managed explicitly via `release_slot()` so that the Lua layer can release
/// exactly once per request, regardless of whether the request was admitted
/// (200, slot held through proxy) or rejected early (slot already released
/// inside `process_request`). This avoids the classic double-release bug that
/// drives the in-flight gauge negative under load.
///
/// # Safety
/// `upstream_ptr` must be a valid null-terminated C string or NULL.
#[no_mangle]
pub unsafe extern "C" fn report_telemetry(
    status: i32,
    latency_us: usize,
    upstream_ptr: *const c_char,
) {
    telemetry::record_request(status, latency_us);
    otlp::record_request(status, latency_us as u64);

    let upstream = if !upstream_ptr.is_null() {
        CStr::from_ptr(upstream_ptr).to_str().unwrap_or("").to_string()
    } else {
        String::new()
    };

    if !upstream.is_empty() {
        load_balancing::record_upstream_latency(&upstream, latency_us as u64);
        if status >= 500 {
            load_balancing::record_failure_for(&upstream);
        } else {
            load_balancing::record_success_for(&upstream);
        }
    } else if status >= 500 {
        load_balancing::record_failure();
    } else {
        load_balancing::record_success();
    }
}

/// Release the concurrency (backpressure) slot held by an admitted request.
#[no_mangle]
pub extern "C" fn release_slot() {
    backpressure::release();
}

/// Returns 1 when config has been loaded and routes are available.
#[no_mangle]
pub extern "C" fn is_ready() -> i32 {
    if config::is_config_ready() { 1 } else { 0 }
}

/// Write the active config version into `buf` (NUL-terminated). Returns bytes written.
#[no_mangle]
pub unsafe extern "C" fn get_config_version(buf: *mut c_char, len: usize) -> i32 {
    if buf.is_null() || len == 0 {
        return 0;
    }
    let version = config::GLOBAL_CONFIG.load().version.clone();
    write_c_string(&version, buf, len);
    version.len().min(len.saturating_sub(1)) as i32
}

// ── Hot path ──────────────────────────────────────────────────────────────────

/// Main hot-path function. Called from NGINX `access_by_lua_block`.
///
/// # Safety
/// All pointer arguments must be valid null-terminated C strings or NULL.
/// Output buffers must be writable and at least `*_out_len` bytes.
///
/// New parameters vs v0.5:
/// - `body_ptr`/`body_len` — request body (first 8KB), NULL/0 for GET/HEAD. The
///   length is explicit (not C-string scanned) so embedded NUL bytes cannot
///   truncate the buffer and hide an attack payload from the WAF.
/// - `client_ip_ptr` — source IP string for per-IP WAF rate limiting
/// - `req_id_out`    — output buffer for generated X-Request-ID (32 bytes)
///
/// # Returns
/// - `200` — OK
/// - `400` — Bad Request
/// - `401` — Unauthorized
/// - `403` — Forbidden
/// - `404` — Not Found
/// - `429` — Too Many Requests
/// - `500` — Internal error
/// - `503` — Service Unavailable
#[no_mangle]
pub unsafe extern "C" fn process_request(
    auth_header_ptr:  *const c_char,
    path_ptr:         *const c_char,
    user_agent_ptr:   *const c_char,
    body_ptr:         *const c_char,
    body_len:         usize,
    client_ip_ptr:    *const c_char,
    canary_hint_ptr:  *const c_char,
    content_type_ptr: *const c_char,
    region_out_ptr:   *mut c_char,
    region_out_len:   usize,
    upstream_out_ptr: *mut c_char,
    upstream_out_len: usize,
    req_id_out_ptr:   *mut c_char,
    req_id_out_len:   usize,
    user_id_out_ptr:  *mut c_char,
    user_id_out_len:  usize,
    home_region_out_ptr: *mut c_char,
    home_region_out_len: usize,
    tier_out_ptr:     *mut c_char,
    tier_out_len:     usize,
) -> i32 {
    // 0. Backpressure
    if !backpressure::acquire() {
        return 503;
    }

    if auth_header_ptr.is_null() || path_ptr.is_null() || region_out_ptr.is_null() {
        backpressure::release();
        return 500;
    }

    let auth_header = std::str::from_utf8(CStr::from_ptr(auth_header_ptr).to_bytes()).unwrap_or("");
    let path        = std::str::from_utf8(CStr::from_ptr(path_ptr).to_bytes()).unwrap_or("");
    let user_agent  = if !user_agent_ptr.is_null() {
        std::str::from_utf8(CStr::from_ptr(user_agent_ptr).to_bytes()).unwrap_or("")
    } else {
        ""
    };
    // Body is length-delimited (NOT a C string): an attacker can put a NUL byte
    // anywhere in a request body, and CStr would stop there, hiding everything
    // after it from the WAF. Reconstruct from ptr+len and decode lossily so that
    // ASCII attack patterns embedded in otherwise-binary/invalid-UTF-8 bodies are
    // still scanned (from_utf8 would otherwise discard the whole body).
    let body: std::borrow::Cow<str> = if !body_ptr.is_null() && body_len > 0 {
        let slice = std::slice::from_raw_parts(body_ptr as *const u8, body_len);
        String::from_utf8_lossy(slice)
    } else {
        std::borrow::Cow::Borrowed("")
    };
    let client_ip = if !client_ip_ptr.is_null() {
        std::str::from_utf8(CStr::from_ptr(client_ip_ptr).to_bytes()).unwrap_or("")
    } else {
        ""
    };
    // Canary stickiness hint (header/cookie value computed in Lua, ADR-0063).
    let canary_hint = if !canary_hint_ptr.is_null() {
        std::str::from_utf8(CStr::from_ptr(canary_hint_ptr).to_bytes()).unwrap_or("")
    } else {
        ""
    };
    let content_type = if !content_type_ptr.is_null() {
        std::str::from_utf8(CStr::from_ptr(content_type_ptr).to_bytes()).unwrap_or("")
    } else {
        ""
    };

    // Generate X-Request-ID zero-allocation
    let mut req_id_buf = [0u8; 24];
    use std::io::Write;
    let _ = write!(
        &mut req_id_buf[..],
        "{:08x}{:016x}",
        std::process::id(),
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    write_c_string(std::str::from_utf8(&req_id_buf).unwrap_or(""), req_id_out_ptr, req_id_out_len);

    // 1. WAF — scans the FULL request URI (path + query string), plus body,
    //    UA, and per-IP limits. `path` here is ngx.var.request_uri.
    match waf::inspect(path, auth_header, user_agent, &body, client_ip) {
        WafDecision::Block(status, _) => {
            backpressure::release();
            return status as i32;
        }
        WafDecision::Allow => {}
    }

    // 2. JWT auth + identity
    let identity = auth::validate_token(auth_header);

    // 3. Routing — uses only the path component (strip the query string), so
    //    the radix router matches on the path regardless of query parameters.
    let route_path = path.split('?').next().unwrap_or(path);
    let cb_state = load_balancing::global_state() as i32;
    let resolved_result = router::route_request(route_path, identity.as_ref(), cb_state);

    let resolved = match resolved_result {
        Ok(r) => r,
        Err(status) => {
            backpressure::release();
            return status;
        }
    };

    let service = match &resolved.service {
        Some(s) => s,
        None => {
            backpressure::release();
            return 404;
        }
    };

    // Timeout-policy tier for nginx's matching internal location (ADR-0062).
    if !tier_out_ptr.is_null() {
        write_c_string(&resolved.tier, tier_out_ptr, tier_out_len);
    }

    // ── 4b. Per-route body validation (ADR-0064) ───────────────────────────
    if let Some(policy) = resolved.validation.as_deref() {
        match validate::validate_body(policy, content_type, &body) {
            Ok(()) => {}
            Err(v) => {
                let (status, reason) = v.response();
                eprintln!(
                    "[validate] reject {status} {reason} uri={}",
                    path.split('?').next().unwrap_or(path)
                );
                backpressure::release();
                return status as i32;
            }
        }
    }
    // 4. Auth enforcement
    if service.require_auth && identity.is_none() {
        backpressure::release();
        return 401;
    }

    // 5. Per-user rate limiting — runs BEFORE quota so requests rejected for
    //    burst rate never consume the daily allowance (ADR-0066 flow fix).
    let user_key = identity.as_ref().map(|id| id.user_id.as_str());
    if !rate_limit::check_rate_limit(service.rate_limit_max, user_key) {
        backpressure::release();
        return 429;
    }

    // 5b. Per-user daily quota (ADR-0066) — authenticated, admitted traffic.
    if let (Some(id), Some(q)) = (identity.as_ref(), service.quota.as_ref()) {
        if !quota::check_quota(&service.name, &id.user_id, q) {
            eprintln!("[quota] {}/{} exceeded daily limit {}", service.name, id.user_id, q.daily_limit);
            backpressure::release();
            return 429;
        }
    }

    // 6. Load balancing
    match load_balancing::select_upstream(Some(service), &resolved.region, user_key, canary_hint) {
        Some(upstream_name) => {
            write_c_string(&resolved.region, region_out_ptr, region_out_len);
            if !upstream_out_ptr.is_null() {
                write_c_string(&upstream_name, upstream_out_ptr, upstream_out_len);
            }
            if let Some(id) = identity.as_ref() {
                if !user_id_out_ptr.is_null() {
                    write_c_string(&id.user_id, user_id_out_ptr, user_id_out_len);
                }
                if let Some(ref home) = id.home_region {
                    if !home_region_out_ptr.is_null() {
                        write_c_string(home, home_region_out_ptr, home_region_out_len);
                    }
                }
            }
            200
        }
        None => {
            backpressure::release();
            503
        }
    }
}

// ── Prometheus metrics ────────────────────────────────────────────────────────

/// # Safety
/// Caller MUST call `free_metrics_string` on the returned pointer.
#[no_mangle]
pub extern "C" fn get_metrics_string() -> *mut c_char {
    match CString::new(telemetry::prometheus_text()) {
        Ok(cs) => cs.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

/// # Safety
/// `ptr` must be a pointer previously returned by `get_metrics_string`.
#[no_mangle]
pub unsafe extern "C" fn free_metrics_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(CString::from_raw(ptr));
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn write_c_string(s: &str, buf: *mut c_char, len: usize) {
    if buf.is_null() || len == 0 {
        return;
    }
    let bytes    = s.as_bytes();
    let copy_len = bytes.len().min(len - 1);
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr(), buf as *mut u8, copy_len);
        *buf.add(copy_len) = 0;
    }
}
