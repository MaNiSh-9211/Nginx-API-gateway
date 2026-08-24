//! Self-Calibrating Baselines (ADR-0074) — INVENTION.
//!
//! Every monitoring threshold ever written goes stale: someone picks
//! "alert if >5% errors", traffic doubles, and the threshold either cries
//! wolf or sleeps through real incidents.
//!
//! This module removes human tuning entirely. Each signal feeds a fixed-size
//! ring of recent observations; we derive a robust baseline using
//! **median + MAD** (median absolute deviation — immune to outliers by
//! construction, unlike mean/stddev which the outliers themselves poison).
//!
//! Trigger rule: value is anomalous when
//!     v > median + k × MAD × 1.4826    (1.4826 ≈ MAD→σ for normal dist)
//! AND v exceeds an absolute floor (never alerts on genuinely quiet systems
//! where MAD≈0).
//!
//! Cost: O(n log n) copy-sort of ≤256 floats at 1 Hz — negligible.

pub const RING_CAP: usize = 256;

#[derive(Debug)]
pub struct MadBaseline {
    buf: Vec<f64>,
    idx: usize,
    filled: usize,
}

impl MadBaseline {
    pub fn new() -> Self {
        Self { buf: vec![0.0; RING_CAP], idx: 0, filled: 0 }
    }

    pub fn observe(&mut self, v: f64) {
        self.buf[self.idx] = v;
        self.idx = (self.idx + 1) % RING_CAP;
        self.filled = (self.filled + 1).min(RING_CAP);
    }

    pub fn len(&self) -> usize {
        self.filled
    }

    pub fn is_empty(&self) -> bool {
        self.filled == 0
    }

    /// Median of the filled ring. Copies + sorts (≤256 elems @ 1 Hz: free).
    pub fn median(&self) -> f64 {
        let mut vals: Vec<f64> = self.buf[..self.filled].to_vec();
        vals.retain(|v| v.is_finite());
        if vals.is_empty() {
            return 0.0;
        }
        vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mid = vals.len() / 2;
        if vals.len() % 2 == 1 {
            vals[mid]
        } else {
            (vals[mid - 1] + vals[mid]) / 2.0
        }
    }

    /// Median absolute deviation — robust spread estimator.
    pub fn mad(&self) -> f64 {
        let med = self.median();
        let mut devs: Vec<f64> = self.buf[..self.filled]
            .iter()
            .filter(|v| v.is_finite())
            .map(|v| (v - med).abs())
            .collect();
        if devs.is_empty() {
            return 0.0;
        }
        devs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mid = devs.len() / 2;
        if devs.len() % 2 == 1 {
            devs[mid]
        } else {
            (devs[mid - 1] + devs[mid]) / 2.0
        }
    }

    /// Anomalous when v exceeds `median + k·MAD·1.4826` (with the absolute
    /// floor acting as a minimum bar). Degenerate cases handled explicitly:
    ///   * fewer than 2 observations → never anomalous (no evidence yet)
    ///   * MAD == 0 (perfectly constant series) → require a 1.5× relative
    ///     jump from the median instead, since spread carries no signal there.
    pub fn is_anomalous(&self, v: f64, k: f64, floor: f64) -> bool {
        if self.filled < 2 || !v.is_finite() || v <= floor {
            return false;
        }
        let med = self.median();
        let mad = self.mad();
        let threshold = if mad > 0.0 {
            med + k * mad * 1.4826
        } else {
            // Constant baseline: demand a meaningful relative jump.
            med * 1.5
        };
        v > threshold.max(floor)
    }
}

impl Default for MadBaseline {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_baseline_never_anomalous() {
        let b = MadBaseline::new();
        assert!(!b.is_anomalous(1_000_000.0, 6.0, 10.0));
    }

    #[test]
    fn calm_series_detects_spike() {
        let mut b = MadBaseline::new();
        for _ in 0..100 {
            b.observe(10.0);
        }
        // MAD == 0 for constant series → floor must carry the decision.
        assert!(b.is_anomalous(500.0, 6.0, 50.0));
        assert!(!b.is_anomalous(12.0, 6.0, 10.0));
    }

    #[test]
    fn noisy_series_tolerance() {
        let mut b = MadBaseline::new();
        let mut v = 100.0f64;
        for i in 0..200 {
            // deterministic pseudo-noise ±20%
            v = 100.0 + ((i * 37) % 40) as f64 - 20.0;
            b.observe(v);
        }
        let spike = b.median() * 4.0 + 50.0;
        assert!(b.is_anomalous(spike, 6.0, 10.0));
        // A value inside the normal band must NOT trip.
        assert!(!b.is_anomalous(b.median() + 5.0, 6.0, 10.0));
    }

    #[test]
    fn ring_wraps_and_forgets_old_regime() {
        let mut b = MadBaseline::new();
        for _ in 0..300 {
            b.observe(1000.0); // old regime floods the ring
        }
        for _ in 0..300 {
            b.observe(10.0); // new regime replaces it (ring cap 256)
        }
        assert_eq!(b.len(), 256);
        let med = b.median();
        assert!(med < 50.0, "old regime should be forgotten, med={med}");
    }

    #[test]
    fn nan_observations_ignored() {
        let mut b = MadBaseline::new();
        b.observe(f64::NAN);
        b.observe(5.0);
        b.observe(5.0);
        assert_eq!(b.median(), 5.0);
    }
}
