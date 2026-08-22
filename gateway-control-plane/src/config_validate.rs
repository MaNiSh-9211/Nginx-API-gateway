//! Config validation & diff (ADR-0065) — gap #7.
//!
//! `POST /config` used to accept anything structurally deserializable:
//! routes pointing at nonexistent services, duplicate prefixes, broken
//! upstream addresses — silently distributed to every gateway worker.
//!
//! Now every apply runs [`validate_config`]; any ERROR rejects the push
//! (400). Operators can preview with `?dry_run=1`, which also returns a
//! [`diff_report`] against the live snapshot without applying.

use std::collections::{HashMap, HashSet};

use crate::{ConfigSnapshot, ServiceConfig};

#[derive(serde::Serialize, Clone, Debug)]
pub struct ValidationReport {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct DiffReport {
    pub routes_added: Vec<String>,
    pub routes_removed: Vec<String>,
    pub routes_changed: Vec<String>,
    pub services_added: Vec<String>,
    pub services_removed: Vec<String>,
    pub services_changed: Vec<String>,
    pub canary_changed: Vec<String>,
    pub health_check_changed: bool,
}

impl DiffReport {
    pub fn is_empty(&self) -> bool {
        self.routes_added.is_empty()
            && self.routes_removed.is_empty()
            && self.routes_changed.is_empty()
            && self.services_added.is_empty()
            && self.services_removed.is_empty()
            && self.services_changed.is_empty()
            && self.canary_changed.is_empty()
            && !self.health_check_changed
    }
}

/// Deep semantic validation. Errors block distribution; warnings do not.
pub fn validate_config(snap: &ConfigSnapshot) -> ValidationReport {
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    if snap.version.trim().is_empty() {
        errors.push("version must be non-empty".into());
    }

    // ── Routes ────────────────────────────────────────────────────────────
    let mut seen_prefixes: HashSet<&str> = HashSet::new();
    for r in &snap.routes {
        let key = r.path_prefix.trim();
        if key.is_empty() || !key.starts_with('/') {
            errors.push(format!(
                "route '{}' has an invalid path_prefix (must start with '/')",
                r.path_prefix
            ));
            continue;
        }
        if !seen_prefixes.insert(key) {
            errors.push(format!("duplicate route path_prefix '{key}'"));
        }
        if !snap.services.contains_key(&r.service_name) {
            errors.push(format!(
                "route '{key}' references unknown service '{}'",
                r.service_name
            ));
        }
        match r.tier.as_str() {
            "" | "fast" | "normal" | "slow" => {}
            other => errors.push(format!("route '{key}' has unknown tier '{other}'")),
        }
        if let Some(v) = r.validation.as_ref() {
            if let Some(max) = v.get("max_body_bytes").and_then(|x| x.as_u64()) {
                if max == 0 || max > 10_485_760 {
                    warnings.push(format!(
                        "route '{key}' max_body_bytes={max} outside sane range (1..10MiB)"
                    ));
                }
            }
        }
    }

    // ── Services / upstreams / canary ─────────────────────────────────────
    for (name, svc) in &snap.services {
        if svc.regional_upstreams.is_empty() {
            warnings.push(format!("service '{name}' has no regional_upstreams"));
        }
        for (region, pool) in &svc.regional_upstreams {
            if pool.is_empty() {
                errors.push(format!("service '{name}' region '{region}' has an empty pool"));
            }
            for up in pool {
                let addr = up.address.trim();
                let ok_shape = addr.contains(':')
                    && !addr.starts_with("http")
                    && !addr.contains('/')
                    && !addr.contains(' ');
                if !ok_shape {
                    errors.push(format!(
                        "service '{name}' upstream '{}' address '{addr}' must be bare host:port",
                        up.name
                    ));
                }
                if up.weight > 1000 {
                    warnings.push(format!(
                        "service '{name}' upstream '{}' weight {} unusually high",
                        up.name, up.weight
                    ));
                }
            }
        }
        if let Some(c) = svc.canary.as_ref() {
            let labelled = svc
                .regional_upstreams
                .values()
                .flatten()
                .filter(|u| u.version == c.version)
                .count();
            if labelled == 0 {
                warnings.push(format!(
                    "service '{name}' canary.version='{}' matches no upstream",
                    c.version
                ));
            }
            if c.percent > 100 {
                errors.push(format!(
                    "service '{name}' canary.percent={} exceeds 100",
                    c.percent
                ));
            }
            let pools: usize = svc.regional_upstreams.values().map(Vec::len).sum();
            if pools <= 1 {
                warnings.push(format!(
                    "service '{name}' canary set but pool has ≤1 member — split is meaningless"
                ));
            }
        }
    }

    // ── Health check ──────────────────────────────────────────────────────
    if let Some(hc) = snap.health_check.as_ref() {
        if hc.enabled {
            if hc.interval_secs < 1 {
                errors.push("health_check.interval_secs must be ≥ 1".into());
            }
            if !hc.path.starts_with('/') {
                errors.push("health_check.path must start with '/'".into());
            }
            if hc.unhealthy_threshold == 0 || hc.healthy_threshold == 0 {
                errors.push("health_check thresholds must be ≥ 1".into());
            }
        }
    }

    ValidationReport { valid: errors.is_empty(), errors, warnings }
}

/// Structural diff between the live snapshot and the candidate.
pub fn diff_report(current: &ConfigSnapshot, next: &ConfigSnapshot) -> DiffReport {
    let mut d = DiffReport::default();

    let cur_routes: HashMap<&str, &crate::Route> =
        current.routes.iter().map(|r| (r.path_prefix.as_str(), r)).collect();
    let next_routes: HashMap<&str, &crate::Route> =
        next.routes.iter().map(|r| (r.path_prefix.as_str(), r)).collect();

    for (k, r) in &next_routes {
        if !cur_routes.contains_key(k) {
            d.routes_added.push((*k).to_string());
        } else {
            let c = cur_routes[k];
            if c.service_name != r.service_name || c.tier != r.tier {
                d.routes_changed.push((*k).to_string());
            }
        }
    }
    for k in cur_routes.keys() {
        if !next_routes.contains_key(k) {
            d.routes_removed.push((*k).to_string());
        }
    }

    let changed_service = |a: &ServiceConfig, b: &ServiceConfig| -> Option<String> {
        if a.rate_limit_max != b.rate_limit_max
            || a.require_auth != b.require_auth
            || format!("{:?}", a.regional_upstreams) != format!("{:?}", b.regional_upstreams)
        {
            Some(b.name.clone())
        } else {
            None
        }
    };

    for (n, s) in &next.services {
        match current.services.get(n) {
            None => d.services_added.push(n.clone()),
            Some(cur) => {
                if let Some(ch) = changed_service(cur, s) {
                    d.services_changed.push(ch);
                }
                let canary_differs =
                    serde_json::to_string(&cur.canary).ok() != serde_json::to_string(&s.canary).ok();
                if canary_differs {
                    d.canary_changed.push(n.clone());
                }
            }
        }
    }
    for n in current.services.keys() {
        if !next.services.contains_key(n) {
            d.services_removed.push(n.clone());
        }
    }

    d.health_check_changed =
        serde_json::to_string(&current.health_check).ok() != serde_json::to_string(&next.health_check).ok();

    d
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CanaryPolicy, HealthCheckConfig, Route, ServiceConfig, Upstream};
    use std::collections::HashMap;

    fn base() -> ConfigSnapshot {
        ConfigSnapshot {
            version: "t1".into(),
            global_max_concurrency: 100,
            jwt_secret: String::new(),
            jwt_keys: HashMap::new(),
            expected_issuer: "iss".into(),
            expected_audience: "aud".into(),
            services: HashMap::new(),
            routes: Vec::new(),
            health_check: None,
        }
    }

    fn route(prefix: &str, service: &str, tier: &str) -> Route {
        Route {
            path_prefix: prefix.into(),
            service_name: service.into(),
            strip_prefix: false,
            tier: tier.into(),
            validation: None,
        }
    }

    fn svc(name: &str, addrs: &[&str], versions: &[&str]) -> ServiceConfig {
        let ups: Vec<Upstream> = addrs
            .iter()
            .enumerate()
            .map(|(i, a)| Upstream {
                name: format!("{name}-{i}"),
                address: (*a).into(),
                weight: 1,
                version: versions.get(i).map(|s| s.to_string()).unwrap_or_default(),
            })
            .collect();
        let mut regional = HashMap::new();
        regional.insert("US".into(), ups);
        ServiceConfig {
            name: name.into(),
            rate_limit_max: 100,
            regional_upstreams: regional,
            require_auth: false,
            canary: None,
        }
    }

    #[test]
    fn accepts_the_documented_happy_path() {
        let mut s = base();
        s.services.insert("api".into(), svc("api", &["api:8080"], &[]));
        s.routes.push(route("/api/", "api", "fast"));
        let rep = validate_config(&s);
        assert!(rep.valid, "errors: {:?}", rep.errors);
    }

    #[test]
    fn rejects_unknown_service_reference() {
        let mut s = base();
        s.routes.push(route("/x", "ghost", ""));
        let rep = validate_config(&s);
        assert!(!rep.valid);
        assert!(rep.errors.iter().any(|e| e.contains("unknown service")));
    }

    #[test]
    fn rejects_duplicate_and_bad_prefixes() {
        let mut s = base();
        s.services.insert("api".into(), svc("api", &["api:8080"], &[]));
        s.routes.push(route("/dup", "api", ""));
        s.routes.push(route("/dup", "api", ""));
        s.routes.push(route("nope", "api", ""));
        let rep = validate_config(&s);
        assert!(!rep.valid);
        assert!(rep.errors.iter().any(|e| e.contains("duplicate")));
        assert!(rep.errors.iter().any(|e| e.contains("invalid path_prefix")));
    }

    #[test]
    fn rejects_unknown_tier_and_broken_address() {
        let mut s = base();
        s.services.insert("bad".into(), svc("bad", &["broken-address"], &[]));
        s.routes.push(route("/b", "bad", "turbo"));
        let rep = validate_config(&s);
        assert!(!rep.valid);
        assert!(rep.errors.iter().any(|e| e.contains("unknown tier 'turbo'")));
        assert!(rep.errors.iter().any(|e| e.contains("bare host:port")));
    }

    #[test]
    fn warns_on_canary_without_members_and_rejects_percent_over_100() {
        let mut s = base();
        let mut api = svc("api", &["api:8080"], &[]);
        api.canary = Some(CanaryPolicy { version: "canary".into(), percent: 150 });
        s.services.insert("api".into(), api);
        s.routes.push(route("/", "api", ""));
        let rep = validate_config(&s);
        assert!(!rep.valid, "percent>100 must be an error");
        assert!(rep.warnings.iter().any(|w| w.contains("matches no upstream")));
    }

    #[test]
    fn diff_reports_added_removed_changed() {
        let mut cur = base();
        cur.services.insert("api".into(), svc("api", &["api:8080"], &[]));
        cur.routes.push(route("/keep", "api", ""));
        cur.routes.push(route("/drop", "api", ""));

        let mut next = base();
        next.version = "t2".into();
        let mut api2 = svc("api", &["api:8081"], &[]);
        api2.rate_limit_max = 500;
        next.services.insert("api".into(), api2);
        next.services.insert("new".into(), svc("new", &["new:8080"], &[]));
        next.routes.push(route("/keep", "api", "slow"));
        next.routes.push(route("/add", "new", ""));

        let d = diff_report(&cur, &next);
        assert_eq!(d.routes_added, vec!["/add"]);
        assert_eq!(d.routes_removed, vec!["/drop"]);
        assert_eq!(d.routes_changed, vec!["/keep"]);
        assert_eq!(d.services_added, vec!["new"]);
        assert!(d.services_changed.iter().any(|s| s == "api"));
    }

    #[test]
    fn health_check_sanity_enforced() {
        let mut s = base();
        s.health_check = Some(HealthCheckConfig {
            enabled: true,
            path: "health".into(),
            interval_secs: 0,
            timeout_ms: 1000,
            unhealthy_threshold: 0,
            healthy_threshold: 1,
        });
        let rep = validate_config(&s);
        assert!(!rep.valid);
        assert_eq!(rep.errors.len(), 3, "path, interval, threshold: {:?}", rep.errors);
    }
}
