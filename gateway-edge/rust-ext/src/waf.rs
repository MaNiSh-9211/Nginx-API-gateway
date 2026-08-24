//! WAF — Web Application Firewall (Native & Lock-free)
//!
//! Security layers:
//!   1. Size guards          — URI, auth header, body, User-Agent limits
//!   2. URI injection scan   — URL-decodes and scans via Aho-Corasick
//!   3. Body injection scan  — same automaton applied to POST/PUT/PATCH bodies
//!   4. Bot UA detection     — Aho-Corasick on User-Agent
//!   5. Per-IP rate limiting — anonymous traffic limited by source IP (Global via Shared Mem)

use aho_corasick::AhoCorasick;
use rustc_hash::FxHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::sync::OnceLock;

// ── Shared Memory for WAF State ───────────────────────────────────────────────

const IP_RATE_LIMIT_SLOTS: usize = 1_000_000;
const SHM_SIZE: usize = (IP_RATE_LIMIT_SLOTS + 1) * 8; // +1 slot for WAF_BLOCKS counter

static SHM_PTR: OnceLock<usize> = OnceLock::new();

fn init_shm() -> usize {
    let path = std::env::temp_dir().join("gateway_waf.shm");
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
    std::mem::forget(mmap);
    ptr
}

fn get_waf_blocks_counter() -> &'static AtomicU64 {
    let ptr = *SHM_PTR.get_or_init(init_shm) as *const AtomicU64;
    unsafe { &*ptr.add(0) }
}

fn get_ip_bucket(ip_hash: u64) -> &'static AtomicU64 {
    let slot = (ip_hash % (IP_RATE_LIMIT_SLOTS as u64)) as usize + 1;
    let ptr = *SHM_PTR.get_or_init(init_shm) as *const AtomicU64;
    unsafe { &*ptr.add(slot) }
}

pub fn increment_waf_blocks() {
    get_waf_blocks_counter().fetch_add(1, Ordering::Relaxed);
}

/// Total WAF blocks since process start (shared across workers).
pub fn waf_blocks_total() -> u64 {
    get_waf_blocks_counter().load(Ordering::Relaxed)
}

// ── Injection patterns ────────────────────────────────────────────────────────

static INJECTION_PATTERNS: &[&str] = &[
    "../", "..\\", 
    "<script", "</script>", "javascript:", "onerror=", "onload=", "alert(",
    "union select", "union all select", "' or '1'='1", "\" or \"1\"=\"1", "or 1=1",
    "exec(", "execute(", "xp_cmdshell", "sp_executesql",
    "/etc/passwd", "/etc/shadow", "/bin/sh", "/bin/bash", "cmd.exe", "powershell",
    "<!entity", "<!doctype", "file://", "dict://", "gopher://",
    "{{", "}}", "${", "#{",
];

static BOT_PATTERNS: &[&str] = &[
    "sqlmap", "nikto", "nmap", "masscan", "zgrab", "dirbuster", "gobuster",
    "nuclei", "hydra", "burpsuite", "metasploit", "w3af", "acunetix", "wfuzz",
];

lazy_static::lazy_static! {
    static ref INJECTION_AC: AhoCorasick = AhoCorasick::builder()
        .ascii_case_insensitive(true)
        .build(INJECTION_PATTERNS)
        .expect("WAF injection automaton build failed");

    static ref BOT_AC: AhoCorasick = AhoCorasick::builder()
        .ascii_case_insensitive(true)
        .build(BOT_PATTERNS)
        .expect("WAF bot automaton build failed");
}

// ── Limits ────────────────────────────────────────────────────────────────────

const MAX_URI_LEN:         usize = 2_048;
const MAX_AUTH_HEADER_LEN: usize = 4_096;
const MAX_UA_LEN:          usize = 512;
const MAX_BODY_SCAN_LEN:   usize = 8_192;

/// Per-IP RPS for unauthenticated traffic. Override with `WAF_IP_RATE_LIMIT_RPS`.
fn ip_rate_limit_rps() -> u32 {
    // Sentinel Mode (ADR-0071): under ELEVATED+ posture the per-IP budget is
    // tightened so the whole node defends harder without config changes.
    let sentinel_factor = crate::sentinel::waf_budget_factor();
    let base: u32 = std::env::var("WAF_IP_RATE_LIMIT_RPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(100);
    ((base as f64) * sentinel_factor).max(1.0) as u32
}

/// How many times to peel URL-encoding. Stops early when a pass changes nothing.
/// Bounds work so a crafted `%2525...` chain cannot cause unbounded decoding.
const MAX_DECODE_PASSES:   usize = 3;

/// Truncate `s` to at most `max` bytes **without splitting a UTF-8 character**.
///
/// `&s[..max]` panics when `max` lands inside a multi-byte char. Because this
/// crate is built with `panic = "abort"`, such a panic would abort the whole
/// NGINX worker — a remotely triggerable DoS (e.g. a body or User-Agent with a
/// multi-byte char straddling the limit). Walk back to the nearest boundary.
fn truncate_on_char_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ── Public API ────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub enum WafDecision {
    Allow,
    Block(u16, &'static str),
}

pub fn inspect(uri: &str, auth_header: &str, user_agent: &str, body: &str, client_ip: &str) -> WafDecision {
    if uri.len() > MAX_URI_LEN {
        increment_waf_blocks();
        return WafDecision::Block(400, "URI too long");
    }
    if auth_header.len() > MAX_AUTH_HEADER_LEN {
        increment_waf_blocks();
        return WafDecision::Block(400, "Auth header too large");
    }

    // Recursively URL-decode (up to MAX_DECODE_PASSES) so multi-encoded payloads
    // like %253Cscript (-> %3Cscript -> <script) cannot bypass the scan.
    let decoded_uri = url_decode_recursive(uri);
    if INJECTION_AC.is_match(&decoded_uri) {
        increment_waf_blocks();
        return WafDecision::Block(403, "Forbidden: injection in URI");
    }

    if !body.is_empty() {
        let scan_body = truncate_on_char_boundary(body, MAX_BODY_SCAN_LEN);
        if INJECTION_AC.is_match(scan_body) {
            increment_waf_blocks();
            return WafDecision::Block(403, "Forbidden: injection in body");
        }
    }

    let ua = truncate_on_char_boundary(user_agent, MAX_UA_LEN);
    if BOT_AC.is_match(ua) {
        increment_waf_blocks();
        return WafDecision::Block(403, "Forbidden: bot detected");
    }

    // Rate Limit unauthenticated users
    if auth_header.is_empty() && !client_ip.is_empty() {
        if ip_rate_exceeded(client_ip) {
            increment_waf_blocks();
            return WafDecision::Block(429, "Too Many Requests: IP rate limit");
        }
    }

    WafDecision::Allow
}

fn ip_rate_exceeded(ip: &str) -> bool {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as u32;
    let key = fx_hash(ip);
    let bucket = get_ip_bucket(key);
    let mut current = bucket.load(Ordering::Relaxed);

    loop {
        let current_ts    = (current >> 32) as u32;
        let current_count = (current & 0xFFFF_FFFF) as u32;

        let new_val = if current_ts != now {
            ((now as u64) << 32) | 1
        } else {
            if current_count >= ip_rate_limit_rps() {
                return true;
            }
            ((now as u64) << 32) | (current_count + 1) as u64
        };

        match bucket.compare_exchange_weak(current, new_val, Ordering::AcqRel, Ordering::Relaxed) {
            Ok(_) => return false,
            Err(updated) => current = updated,
        }
    }
}

#[inline]
fn fx_hash(key: &str) -> u64 {
    let mut h = FxHasher::default();
    key.hash(&mut h);
    h.finish()
}

/// Decode percent-encoding repeatedly to defeat multi-encoded evasion.
/// Returns as soon as a pass is a no-op (fully decoded) or after the cap.
fn url_decode_recursive(encoded: &str) -> String {
    let mut current = url_decode(encoded);
    for _ in 1..MAX_DECODE_PASSES {
        let next = url_decode(&current);
        if next == current {
            break;
        }
        current = next;
    }
    current
}

fn url_decode(encoded: &str) -> String {
    let mut decoded = String::with_capacity(encoded.len());
    let mut chars = encoded.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            if let (Some(h1), Some(h2)) = (chars.next(), chars.next()) {
                if let (Some(d1), Some(d2)) = (h1.to_digit(16), h2.to_digit(16)) {
                    decoded.push((d1 * 16 + d2) as u8 as char);
                    continue;
                }
                decoded.push('%');
                decoded.push(h1);
                decoded.push(h2);
            } else {
                decoded.push(c);
            }
        } else if c == '+' {
            decoded.push(' ');
        } else {
            decoded.push(c);
        }
    }
    decoded
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_clean_request() {
        assert_eq!(
            inspect("/api/v1/users?page=2", "Bearer abc", "curl/8.0", "", "10.0.0.1"),
            WafDecision::Allow
        );
    }

    #[test]
    fn blocks_sql_injection_in_query() {
        // Query-string SQLi is caught because the full request URI is scanned.
        match inspect("/search?q=1' or '1'='1", "Bearer abc", "curl/8.0", "", "10.0.0.1") {
            WafDecision::Block(403, _) => {}
            other => panic!("expected 403 block, got {other:?}"),
        }
    }

    #[test]
    fn blocks_encoded_traversal_in_query() {
        // %2e%2e%2f decodes to ../ → blocked after URL-decoding.
        match inspect("/d?p=%2e%2e%2fetc%2fpasswd", "Bearer abc", "curl/8.0", "", "10.0.0.1") {
            WafDecision::Block(403, _) => {}
            other => panic!("expected 403 block, got {other:?}"),
        }
    }

    #[test]
    fn blocks_known_scanner_user_agent() {
        match inspect("/", "Bearer abc", "sqlmap/1.7", "", "10.0.0.1") {
            WafDecision::Block(403, _) => {}
            other => panic!("expected 403 block, got {other:?}"),
        }
    }

    #[test]
    fn blocks_injection_in_body() {
        match inspect("/submit", "Bearer abc", "curl/8.0", "{\"x\":\"<script>alert(1)</script>\"}", "10.0.0.1") {
            WafDecision::Block(403, _) => {}
            other => panic!("expected 403 block, got {other:?}"),
        }
    }

    #[test]
    fn blocks_injection_after_nul_byte_in_body() {
        // Regression: the body crosses the FFI boundary length-delimited (ptr+len),
        // not as a C string, so a NUL byte before the payload must NOT hide it.
        // This asserts the scanner itself handles interior NULs in the body.
        let body = "\0\0<script>alert(1)</script>";
        match inspect("/submit", "Bearer abc", "curl/8.0", body, "10.0.0.1") {
            WafDecision::Block(403, _) => {}
            other => panic!("expected 403 block on post-NUL payload, got {other:?}"),
        }
    }

    #[test]
    fn blocks_oversized_uri() {
        let big = format!("/{}", "a".repeat(MAX_URI_LEN + 1));
        match inspect(&big, "", "curl/8.0", "", "10.0.0.1") {
            WafDecision::Block(400, _) => {}
            other => panic!("expected 400 block, got {other:?}"),
        }
    }

    #[test]
    fn blocks_double_encoded_xss() {
        // %253Cscript -> %3Cscript -> <script. Single-pass decode would miss this.
        match inspect("/p?x=%253Cscript%253E", "Bearer abc", "curl/8.0", "", "10.0.0.1") {
            WafDecision::Block(403, _) => {}
            other => panic!("expected 403 block on double-encoded XSS, got {other:?}"),
        }
    }

    #[test]
    fn blocks_double_encoded_traversal() {
        // %252e%252e%252f -> %2e%2e%2f -> ../
        match inspect("/d?p=%252e%252e%252fetc%252fpasswd", "Bearer abc", "curl/8.0", "", "10.0.0.1") {
            WafDecision::Block(403, _) => {}
            other => panic!("expected 403 block on double-encoded traversal, got {other:?}"),
        }
    }

    #[test]
    fn recursive_decode_peels_layers() {
        assert_eq!(url_decode_recursive("%253Cscript"), "<script");
        assert_eq!(url_decode_recursive("%2e%2e%2f"), "../");
        // Plain text is unchanged.
        assert_eq!(url_decode_recursive("/api/v1/users"), "/api/v1/users");
    }

    #[test]
    fn recursive_decode_is_bounded() {
        // A long chain of encodings must not loop forever; it just stops at the cap.
        let s = "%25".repeat(10) + "3Cscript";
        let _ = url_decode_recursive(&s); // must return without hanging
    }

    #[test]
    fn truncate_respects_char_boundary() {
        // '€' is 3 bytes (E2 82 AC). Cutting at byte 1 or 2 would split it.
        let s = "€€€";
        assert_eq!(truncate_on_char_boundary(s, 1), "");
        assert_eq!(truncate_on_char_boundary(s, 2), "");
        assert_eq!(truncate_on_char_boundary(s, 3), "€");
        assert_eq!(truncate_on_char_boundary(s, 4), "€");
        assert_eq!(truncate_on_char_boundary(s, 100), "€€€");
        // ASCII truncates exactly.
        assert_eq!(truncate_on_char_boundary("abcdef", 3), "abc");
    }

    #[test]
    fn multibyte_body_at_scan_limit_does_not_panic() {
        // Body whose multi-byte char straddles MAX_BODY_SCAN_LEN. With panic=abort
        // a naive `&body[..MAX_BODY_SCAN_LEN]` would abort the worker (DoS).
        let mut body = "a".repeat(MAX_BODY_SCAN_LEN - 1);
        body.push('€'); // 3-byte char now spans the limit boundary
        body.push_str("trailing");
        // Must return a decision, not panic.
        let _ = inspect("/submit", "Bearer abc", "curl/8.0", &body, "10.0.0.1");
    }

    #[test]
    fn multibyte_user_agent_at_limit_does_not_panic() {
        let mut ua = "a".repeat(MAX_UA_LEN - 1);
        ua.push('€');
        ua.push_str("more");
        let _ = inspect("/", "Bearer abc", &ua, "", "10.0.0.1");
    }
}
