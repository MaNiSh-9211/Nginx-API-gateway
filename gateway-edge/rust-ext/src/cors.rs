//! Dynamic CORS (ADR-0068) — origins/methods/headers live in the distributed
//! config, hot-reloaded like everything else. No redeploy to add an origin.
//!
//! Decision model:
//!   * no `cors` section            → edge emits NO CORS headers (API-only mode)
//!   * origin in allowed_origins    → echo that exact origin
//!   * "*" listed                   → wildcard (credentials auto-disabled —
//!     browsers reject `*` + credentials; we force it so configs stay valid)
//!   * anything else                → deny (no ACAO header emitted)
//!
//! Exposed to Lua through one FFI getter returning a packed string
//! (`\x1f`-separated) so a single out-buffer carries all five headers.

use crate::config::GLOBAL_CONFIG;

pub const SEP: char = '\u{1f}';
const SEP_STR: &str = "\u{1f}";

/// Resolve the Access-Control-Allow-Origin value for this request.
pub fn allow_origin(cfg: &crate::config::CorsConfig, origin: &str) -> Option<String> {
    if origin.trim().is_empty() {
        return None;
    }
    let wildcard = cfg.allowed_origins.iter().any(|o| o == "*");
    if wildcard {
        // Browsers reject "*" combined with credentials; force it off so the
        // emitted headers are always internally consistent.
        return Some("*".to_string());
    }
    let exact = cfg.allowed_origins.iter().any(|o| o.eq_ignore_ascii_case(origin));
    if exact && cfg.allow_credentials {
        Some(origin.to_string())
    } else if exact {
        Some(origin.to_string())
    } else {
        None
    }
}

fn effective_credentials(cfg: &crate::config::CorsConfig, origin_value: &str) -> bool {
    cfg.allow_credentials && origin_value != "*"
}

/// Pack all response headers into one `\x1f`-separated string for the FFI
/// out-buffer. Empty string ⇒ not allowed / CORS disabled.
pub fn packed_headers(origin: &str) -> String {
    let Some(cfg) = GLOBAL_CONFIG.load().cors.clone() else {
        return String::new();
    };
    let Some(allow_origin) = allow_origin(&cfg, origin) else {
        return String::new();
    };
    let creds = if effective_credentials(&cfg, &allow_origin) {
        "true"
    } else {
        "false"
    };
    [
        allow_origin,
        cfg.allowed_methods.clone(),
        cfg.allowed_headers.clone(),
        cfg.max_age.to_string(),
        creds.to_string(),
    ]
    .join(SEP_STR)
}

/// Test-only helper: swap the global cors section (kept here so the
/// ArcSwap dance lives next to the definition it mutates).
#[cfg(test)]
pub mod test_hooks {
    use std::sync::Arc;
    use crate::config::{GatewayConfig, GLOBAL_CONFIG};

    pub fn set_cors(c: crate::config::CorsConfig) {
        let mut snap = GatewayConfig::default();
        snap.cors = Some(c);
        GLOBAL_CONFIG.store(Arc::new(snap));
    }

    pub fn clear_cors() {
        let mut snap = GatewayConfig::default();
        snap.cors = None;
        GLOBAL_CONFIG.store(Arc::new(snap));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CorsConfig;
    use arc_swap::ArcSwap;
    use std::sync::Arc;

    fn set_cors(c: crate::config::CorsConfig) {
        // Swap only the cors field of the global default snapshot.
        super::test_hooks::set_cors(c);
    }

    fn cfg(origins: &[&str], creds: bool) -> CorsConfig {
        CorsConfig {
            allowed_origins: origins.iter().map(|s| s.to_string()).collect(),
            allow_credentials: creds,
            allowed_methods: "GET, POST".into(),
            allowed_headers: "Content-Type".into(),
            max_age: 300,
        }
    }

    #[test]
    fn exact_origin_echoed_with_credentials() {
        set_cors(cfg(&["https://app.example.com"], true));
        assert_eq!(
            allow_origin(
                &GLOBAL_CONFIG.load().cors.clone().unwrap(),
                "https://app.example.com"
            ),
            Some("https://app.example.com".into())
        );
    }

    #[test]
    fn disallowed_origin_denied() {
        set_cors(cfg(&["https://app.example.com"], false));
        assert_eq!(
            allow_origin(
                &GLOBAL_CONFIG.load().cors.clone().unwrap(),
                "https://evil.example.net"
            ),
            None
        );
    }

    #[test]
    fn wildcard_disables_credentials_implicitly() {
        set_cors(cfg(&["*"], true)); // operator error — we correct it
        let c = GLOBAL_CONFIG.load().cors.clone().unwrap();
        assert_eq!(allow_origin(&c, "https://any.origin"), Some("*".into()));
        assert!(!effective_credentials(&c, "*"));
    }

    #[test]
    fn case_insensitive_scheme_host_match() {
        set_cors(cfg(&["https://App.Example.com"], false));
        assert_eq!(
            allow_origin(
                &GLOBAL_CONFIG.load().cors.clone().unwrap(),
                "https://app.example.com"
            ),
            Some("https://app.example.com".into())
        );
    }

    #[test]
    fn packed_headers_shape() {
        set_cors(cfg(&["https://a.dev"], true));
        let p = packed_headers("https://a.dev");
        let parts: Vec<&str> = p.split(SEP).collect();
        assert_eq!(parts[0], "https://a.dev");
        assert_eq!(parts[3], "300");
        assert_eq!(parts[4], "true");
    }

    #[test]
    fn packed_empty_when_cors_absent() {
        super::test_hooks::clear_cors();
        assert_eq!(packed_headers("https://a.dev"), "");
    }
}
