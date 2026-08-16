use std::cell::RefCell;
use std::collections::HashMap;

struct UpstreamStats {
    ema_latency_us: f64,
    request_count: u64,
}

impl UpstreamStats {
    fn new() -> Self {
        Self { ema_latency_us: 0.0, request_count: 0 }
    }

    fn update(&mut self, latency_us: f64) {
        const ALPHA: f64 = 0.1;
        self.ema_latency_us = if self.request_count == 0 {
            latency_us
        } else {
            ALPHA * latency_us + (1.0 - ALPHA) * self.ema_latency_us
        };
        self.request_count += 1;
    }

    fn ema_or_max(&self) -> f64 {
        if self.request_count < 10 {
            f64::MAX
        } else {
            self.ema_latency_us
        }
    }
}

thread_local! {
    static UPSTREAM_STATS: RefCell<HashMap<String, UpstreamStats>> =
        RefCell::new(HashMap::with_capacity(32));
}

pub fn record_upstream_latency(upstream: &str, latency_us: u64) {
    UPSTREAM_STATS.with(|stats| {
        stats
            .borrow_mut()
            .entry(upstream.to_string())
            .or_insert_with(UpstreamStats::new)
            .update(latency_us as f64);
    });
}

pub fn get_ema(upstream: &str) -> f64 {
    UPSTREAM_STATS.with(|stats| {
        stats
            .borrow()
            .get(upstream)
            .map(|s| s.ema_or_max())
            .unwrap_or(f64::MAX)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ema_update_and_read() {
        record_upstream_latency("test-upstream-ema", 500);
        record_upstream_latency("test-upstream-ema", 600);
        let ema = get_ema("test-upstream-ema");
        assert!(ema > 0.0);
    }

    #[test]
    fn cold_upstream_returns_max() {
        assert_eq!(get_ema("upstream-never-seen-xyz"), f64::MAX);
    }
}
