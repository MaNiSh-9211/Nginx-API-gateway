//! Upstream selection — weighted consistent hash + power-of-two-choices + EWMA.

use std::collections::HashSet;

use crate::config::{ServiceConfig, Upstream};
use crate::health::is_healthy;

use super::circuit_breaker::is_upstream_open;
use super::ema::get_ema;
use super::ring::{build_weight_ring, fx_hash_index};

const P2C_LATENCY_ADVANTAGE: f64 = 0.8; // 20% faster EMA wins

/// Select an upstream for the given service + region + user.
pub fn select_upstream(
    service: Option<&ServiceConfig>,
    region: &str,
    user_id: Option<&str>,
) -> Option<String> {
    let svc = service?;
    let upstreams = svc.regional_upstreams.get(region)?;
    if upstreams.is_empty() {
        return None;
    }

    let hash_key = user_id.unwrap_or("anonymous");
    let ring = build_weight_ring(upstreams);
    let primary_slot = fx_hash_index(hash_key, ring.len());
    let alt_slot = fx_hash_index(&format!("{hash_key}:p2c"), ring.len());

    let healthy = collect_healthy_distinct(upstreams, &ring);
    if healthy.is_empty() {
        return None;
    }

    // Power-of-two-choices: two hash-derived slots, pick lower EWMA when both healthy.
    let p2c_pick = pick_p2c(
        upstreams,
        &ring,
        primary_slot,
        alt_slot,
        &healthy,
    );

    if let Some(idx) = p2c_pick {
        return Some(upstreams[idx].address.clone());
    }

    // Failover: walk ring from primary slot for first healthy upstream.
    for offset in 0..ring.len() {
        let idx = ring[(primary_slot + offset) % ring.len()];
        if healthy.contains(&idx) {
            return Some(upstreams[idx].address.clone());
        }
    }

    None
}

fn collect_healthy_distinct(upstreams: &[Upstream], ring: &[usize]) -> HashSet<usize> {
    let mut seen = HashSet::with_capacity(upstreams.len());
    let mut healthy = HashSet::with_capacity(upstreams.len());
    for &idx in ring {
        if !seen.insert(idx) {
            continue;
        }
        let addr = &upstreams[idx].address;
        // Usable = passive circuit breaker closed AND active probes consider
        // it up (ADR-0061). Unknown-by-active-checks addresses are optimistically up.
        if !is_upstream_open(addr) && is_healthy(addr) {
            healthy.insert(idx);
        }
    }
    healthy
}

fn pick_p2c(
    upstreams: &[Upstream],
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
            let ema_a = get_ema(&upstreams[a].address);
            let ema_b = get_ema(&upstreams[b].address);
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
    use crate::config::{ServiceConfig, Upstream};
    use std::collections::HashMap;

    #[test]
    fn no_service_returns_none() {
        assert!(select_upstream(None, "EU", Some("user1")).is_none());
    }

    #[test]
    fn returns_upstream_address_not_name() {
        let mut regional = HashMap::new();
        regional.insert(
            "US".to_string(),
            vec![Upstream {
                name: "us-backend-1".to_string(),
                address: "us-backend-1:8080".to_string(),
                weight: 1,
            }],
        );
        let svc = ServiceConfig {
            name: "default".to_string(),
            rate_limit_max: 1000,
            regional_upstreams: regional,
            require_auth: false,
        };
        let picked = select_upstream(Some(&svc), "US", Some("user-abc")).unwrap();
        assert_eq!(picked, "us-backend-1:8080");
    }
}
