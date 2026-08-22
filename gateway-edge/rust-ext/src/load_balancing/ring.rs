use rustc_hash::FxHasher;
use std::hash::{Hash, Hasher};

use crate::config::Upstream;

/// Weighted consistent-hash ring: upstream index repeated `weight` times (min 1).
pub fn build_weight_ring(upstreams: &[Upstream]) -> Vec<usize> {
    build_weight_ring_positions(upstreams.iter().map(|u| u.weight.max(1)).collect())
}

/// Ring over raw weights (positions into any parallel slice, e.g. subsets).
pub fn build_weight_ring_positions(weights: Vec<usize>) -> Vec<usize> {
    let total: usize = weights.iter().copied().sum();
    let mut ring = Vec::with_capacity(total);
    for (i, w) in weights.iter().enumerate() {
        for _ in 0..(*w).max(1) {
            ring.push(i);
        }
    }
    ring
}

pub fn fx_hash_index(key: &str, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    let mut h = FxHasher::default();
    key.hash(&mut h);
    (h.finish() as usize) % len
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Upstream;

    #[test]
    fn deterministic_same_user() {
        assert_eq!(fx_hash_index("user-abc", 10), fx_hash_index("user-abc", 10));
    }

    #[test]
    fn weighted_ring_length() {
    let upstreams = vec![
        Upstream { name: "a".into(), address: "a:8080".into(), weight: 10, version: String::new() },
        Upstream { name: "b".into(), address: "b:8080".into(), weight: 5, version: String::new() },
    ];
        let ring = build_weight_ring(&upstreams);
        assert_eq!(ring.len(), 15);
        assert_eq!(ring.iter().filter(|&&i| i == 0).count(), 10);
        assert_eq!(ring.iter().filter(|&&i| i == 1).count(), 5);
    }

    #[test]
    fn zero_weight_treated_as_one() {
    let upstreams = vec![
        Upstream { name: "a".into(), address: "a:8080".into(), weight: 0, version: String::new() },
        Upstream { name: "b".into(), address: "b:8080".into(), weight: 0, version: String::new() },
    ];
        assert_eq!(build_weight_ring(&upstreams).len(), 2);
    }
}
