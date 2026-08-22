//! Upstream selection — weighted consistent hash + power-of-two-choices + EWMA
//! + canary splitting (ADR-0063).

use std::collections::HashSet;

use crate::config::{ServiceConfig, Upstream};
use crate::health::is_healthy;

use super::circuit_breaker::is_upstream_open;
use super::ema::get_ema;
use super::ring::{build_weight_ring_positions, fx_hash_index};

const P2C_LATENCY_ADVANTAGE: f64 = 0.8; // 20% faster EMA wins

/// Select an upstream for the given service + region + user.
///
/// `canary_hint` is the client's stickiness value (configured header/cookie,
/// empty when absent). Routing rules (ADR-0063):
///   1. hint == policy.version  → always canary set (sticky tester)
///   2. else deterministic bucket on user key → canary for percent%
///   3. chosen subset has no healthy member → fall back to the other subset
///   4. no policy / no labelled members → whole pool as before
pub fn select_upstream(
    service: Option<&ServiceConfig>,
    region: &str,
    user_id: Option<&str>,
    canary_hint: &str,
) -> Option<String> {
    let svc = service?;
    let upstreams = svc.regional_upstreams.get(region)?;
    if upstreams.is_empty() {
        return None;
    }

    let Some(policy) = svc.canary.as_ref().filter(|p| !p.version.is_empty()) else {
        return select_from(upstreams.iter().collect(), user_id);
    };

    let (canary_refs, stable_refs): (Vec<&Upstream>, Vec<&Upstream>) = upstreams
        .iter()
        .partition(|u| u.version == policy.version);

    if canary_refs.is_empty() {
        return select_from(stable_refs, user_id);
    }

    let sticky = canary_hint == policy.version;
    let bucket_in = {
        let key = user_id.unwrap_or("anonymous");
        let bucket = fx_hash_index(&format!("{key}:canary"), 10_000) as u32;
        bucket < policy.effective_percent() * 100
    };

    if stable_refs.is_empty() {
        // Whole pool is the canary version — nothing to split against.
        return select_from(canary_refs, user_id);
    }

    if sticky || bucket_in {
        select_from(canary_refs, user_id).or_else(|| select_from(stable_refs, user_id))
    } else {
        select_from(stable_refs, user_id).or_else(|| select_from(canary_refs, user_id))
    }
}

/// Core selection over a subset of upstream references.
fn select_from(pool: Vec<&Upstream>, user_id: Option<&str>) -> Option<String> {
    if pool.is_empty() {
        return None;
    }
    let n = pool.len();
    let hash_key = user_id.unwrap_or("anonymous");
    let ring = build_weight_ring_positions(pool.iter().map(|u| u.weight.max(1)).collect());
    let primary_slot = fx_hash_index(hash_key, ring.len());
    let alt_slot = fx_hash_index(&format!("{hash_key}:p2c"), ring.len());

    let healthy = collect_healthy_distinct(&pool, &ring);
    if healthy.is_empty() {
        return None;
    }

    // Power-of-two-choices: two hash-derived slots, pick lower EWMA when both healthy.
    let p2c_pick = pick_p2c(&pool, &ring, primary_slot, alt_slot, &healthy);
    if let Some(pos) = p2c_pick {
        return Some(pool[pos].address.clone());
    }

    // Failover: walk ring from primary slot for first healthy upstream.
    for offset in 0..ring.len() {
        let pos = ring[(primary_slot + offset) % ring.len()];
        if healthy.contains(&pos) {
            return Some(pool[pos].address.clone());
        }
    }
    let _ = n;
    None
}

fn collect_healthy_distinct(pool: &[&Upstream], ring: &[usize]) -> HashSet<usize> {
    let mut seen = HashSet::with_capacity(pool.len());
    let mut healthy = HashSet::with_capacity(pool.len());
    for &pos in ring {
        if !seen.insert(pos) {
            continue;
        }
        let addr = &pool[pos].address;
        // Usable = passive circuit breaker closed AND active probes consider
        // it up (ADR-0061). Unknown-by-active-checks addresses default up.
        if !is_upstream_open(addr) && is_healthy(addr) {
            healthy.insert(pos);
        }
    }
    healthy
}

fn pick_p2c(
    pool: &[&Upstream],
    ring: &[usize],
    primary_slot: usize,
    alt_slot: usize,
    healthy: &HashSet<usize>,
) -> Option<usize> {
    let a = ring[primary_slot % ring.len()];
    let b = ring[alt_slot % ring.len()];

    let a_ok = healthy.contains(&a);
    let b_ok = healthy.contains(&b);

    match (a_ok, b_ok) {
        (true, true) if a != b => {
            let ema_a = get_ema(&pool[a].address);
            let ema_b = get_ema(&pool[b].address);
            if ema_a < f64::MAX && ema_b < f64::MAX {
                if ema_b < ema_a * P2C_LATENCY_ADVANTAGE {
                    Some(b)
                } else if ema_a < ema_b * P2C_LATENCY_ADVANTAGE {
                    Some(a)
                } else {
                    Some(a) // affinity: prefer primary when latencies comparable
                }
            } else {
                Some(a)
            }
        }
        (true, false) => Some(a),
        (false, true) => Some(b),
        (true, true) => Some(a),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CanaryPolicy, ServiceConfig, Upstream};
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Tests share one cross-worker SHM region for active-health flags; this
    /// mutex serializes every test that reads canary health so concurrent
    /// force_set_for_test() calls cannot poison each other's expectations.
    static CANARY_SHM_LOCK: Mutex<()> = Mutex::new(());

    fn svc_with(upstreams: Vec<Upstream>, canary: Option<CanaryPolicy>) -> ServiceConfig {
        let mut regional = HashMap::new();
        regional.insert("US".to_string(), upstreams);
        ServiceConfig {
            name: "default".to_string(),
            rate_limit_max: 1000,
            regional_upstreams: regional,
            require_auth: false,
            canary,
            quota: None,
        }
    }

    fn up(name: &str, weight: usize, version: &str) -> Upstream {
        Upstream { name: name.into(), address: format!("{name}:8080"), weight, version: version.into() }
    }

    #[test]
    fn no_service_returns_none() {
        assert!(select_upstream(None, "EU", Some("user1"), "").is_none());
    }

    #[test]
    fn returns_address_not_name() {
        let svc = svc_with(vec![up("us-backend-1", 1, "")], None);
        assert_eq!(select_upstream(Some(&svc), "US", Some("abc"), "").unwrap(), "us-backend-1:8080");
    }

    #[test]
    fn no_canary_policy_uses_whole_pool() {
        let svc = svc_with(vec![up("a", 1, "stable"), up("b", 1, "x")], None);
        let picked = select_upstream(Some(&svc), "US", Some("u"), "stable").unwrap();
        assert!(picked.starts_with("a:") || picked.starts_with("b:"));
    }

    #[test]
    fn sticky_hint_pins_to_canary_version() {
        let _g = CANARY_SHM_LOCK.lock().unwrap();
        let svc = svc_with(
            vec![up("stable-a", 9, "stable"), up("canary-b", 1, "v2")],
            Some(CanaryPolicy { version: "v2".into(), percent: 0 }), // 0% roll-out
        );
        for _ in 0..20 {
            let picked = select_upstream(Some(&svc), "US", Some("tester"), "v2").unwrap();
            assert_eq!(picked, "canary-b:8080", "sticky hint must pin to canary");
        }
    }

    #[test]
    fn zero_percent_never_buckets_anonymous_into_canary() {
        let svc = svc_with(
            vec![up("stable-a", 1, "stable"), up("canary-b", 9, "v2")],
            Some(CanaryPolicy { version: "v2".into(), percent: 0 }),
        );
        for i in 0..50 {
            let picked = select_upstream(Some(&svc), "US", Some(&format!("user{i}")), "").unwrap();
            assert_eq!(picked, "stable-a:8080", "percent=0 must keep everyone on stable");
        }
    }

    #[test]
    fn full_percent_puts_everyone_on_canary() {
        let _g = CANARY_SHM_LOCK.lock().unwrap();
        let svc = svc_with(
            vec![up("stable-a", 9, "stable"), up("canary-b", 1, "v2")],
            Some(CanaryPolicy { version: "v2".into(), percent: 100 }),
        );
        for i in 0..50 {
            let picked = select_upstream(Some(&svc), "US", Some(&format!("user{i}")), "").unwrap();
            assert_eq!(picked, "canary-b:8080", "percent=100 must send everyone to canary");
        }
    }

    #[test]
    fn partial_percent_splits_population() {
        let _g = CANARY_SHM_LOCK.lock().unwrap();
        let svc = svc_with(
            vec![up("stable-a", 1, "stable"), up("canary-b", 1, "v2")],
            Some(CanaryPolicy { version: "v2".into(), percent: 25 }),
        );
        let mut canary_count = 0;
        let total = 200;
        for i in 0..total {
            let picked = select_upstream(Some(&svc), "US", Some(&format!("user{i}")), "").unwrap();
            if picked.starts_with("canary") {
                canary_count += 1;
            }
        }
        // Deterministic hashing → roughly 25% (loose bounds guard regression).
        assert!(canary_count > 15 && canary_count < 90, "got {canary_count}/{total}");
    }

    #[test]
    fn falls_back_when_canary_member_unhealthy() {
        let _g = CANARY_SHM_LOCK.lock().unwrap();
        let svc = svc_with(
            vec![up("stable-a", 9, "stable"), up("canary-b", 1, "v2")],
            Some(CanaryPolicy { version: "v2".into(), percent: 100 }),
        );
        // Mark the only canary down via active-health SHM.
        crate::health::force_set_for_test("canary-b:8080", false);
        let picked = select_upstream(Some(&svc), "US", Some("someone"), "");
        crate::health::force_set_for_test("canary-b:8080", true);
        assert_eq!(picked.unwrap(), "stable-a:8080", "unhealthy canary must fall back to stable");
    }
}
