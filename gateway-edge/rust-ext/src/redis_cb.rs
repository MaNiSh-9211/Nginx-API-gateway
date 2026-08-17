//! Redis Circuit Breaker + Health Monitor
//!
//! Architecture (per requirements.md §2):
//!
//!   Redis operation
//!         │
//!         ▼
//!   operation timeout / concurrency protection
//!         │
//!         ▼
//!   Health Recorder  ──► latency histogram (10-bucket rolling window)
//!         │          ──► error counter
//!         │          ──► timeout counter
//!         │          ──► consecutive failure counter
//!         ▼
//!   Health Evaluator
//!     ├─ Fast detector:        consecutive failures ≥ threshold → OPEN
//!     └─ Statistical detector: rolling error rate / timeout rate / p99 ≥ threshold → OPEN
//!         │
//!         ▼
//!   Circuit Breaker  (CLOSED → OPEN → HALF_OPEN → CLOSED)
//!         │
//!         ▼
//!   Degradation policy (callers decide: fail-open, fail-closed, use cache)
//!
//! Design decisions:
//!   - Process-local only. No Redis, no network for circuit state.
//!   - Separate concepts: Metrics ≠ Health evaluator ≠ Circuit breaker ≠ Policy.
//!   - Rolling latency: 10 one-second time buckets, p50/p95/p99 computed on demand.
//!   - Two detection mechanisms: fast (consecutive) + statistical (rolling window).
//!   - Hysteresis: different thresholds for OPEN vs RECOVERY (prevents flapping).
//!   - Recovery jitter: randomized cooldown within [base, base + jitter_ms] range.
//!   - Minimum sample size before statistical decisions.
//!   - HALF_OPEN: only N probe requests allowed; all others skip Redis immediately.
//!   - All atomics — no Mutex on the hot path (CLOSED check is a single load).
//!   - Thread-safe, concurrency-safe, no per-request allocation.
//!
//! Operation result taxonomy (per requirements.md §25):
//!   SUCCESS              — Redis responded correctly
//!   REDIS_ERROR          — Redis returned a protocol/command error
//!   TIMEOUT              — I/O or connect deadline exceeded
//!   CIRCUIT_OPEN         — circuit prevented the call (fast rejection)
//!   CONCURRENCY_REJECTED — too many Redis ops in flight (back-pressure)

use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

// ─────────────────────────────────────────────────────────────────────────────
// §25 — Explicit operation result taxonomy
// ─────────────────────────────────────────────────────────────────────────────

/// Result of a Redis operation attempt, as seen by the circuit breaker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedisCallOutcome {
    /// Redis responded correctly.
    Success,
    /// Redis returned a protocol or command-level error (not a timeout).
    RedisError,
    /// Connect or I/O deadline exceeded.
    Timeout,
    /// Circuit is OPEN — Redis was not contacted.
    CircuitOpen,
    /// Local concurrency limit reached — Redis was not contacted.
    ConcurrencyRejected,
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration — all thresholds configurable via env vars
// ─────────────────────────────────────────────────────────────────────────────

/// Configuration thresholds for the Redis Circuit Breaker.
#[derive(Debug, Clone)]
pub struct CbConfig {
    /// Rolling window duration in seconds (= number of time buckets).
    pub window_secs:            u64,
    /// Minimum observations before statistical detector activates.
    pub min_samples:            u64,
    /// Consecutive failure threshold → fast OPEN.
    pub consecutive_fail_open:  u32,
    /// Consecutive timeout threshold → fast OPEN.
    pub consecutive_to_open:    u32,
    /// Error rate threshold [0.0, 1.0] → statistical OPEN.
    pub error_rate_open:        f64,
    /// Timeout rate threshold [0.0, 1.0] → statistical OPEN.
    pub timeout_rate_open:      f64,
    /// p99 latency threshold in µs → statistical OPEN.
    pub p99_us_open:            u64,
    /// p99 latency threshold for RECOVERY (must be lower than open threshold).
    pub p99_us_recovery:        f64,
    /// Error rate threshold for RECOVERY (must be lower than open threshold).
    pub error_rate_recovery:    f64,
    /// Base cooldown before OPEN → HALF_OPEN transition (ms).
    pub open_cooldown_ms:       u64,
    /// Max jitter added to cooldown (ms). Prevents recovery storm at fleet scale.
    pub cooldown_jitter_ms:     u64,
    /// Number of probe requests allowed in HALF_OPEN before decision.
    pub half_open_probes:       u32,
    /// Consecutive successes in HALF_OPEN needed to move to CLOSED.
    pub recovery_successes:     u32,
    /// Max Redis operations in flight (concurrency protection).
    pub max_inflight:           i64,
}

impl CbConfig {
    pub fn from_env() -> Self {
        let window_secs = env_u64("REDIS_CB_WINDOW_SECS", 10);
        let min_samples = env_u64("REDIS_CB_MIN_SAMPLES", 20);
        let consec_fail = env_u32("REDIS_CB_CONSECUTIVE_FAIL_OPEN", 5);
        let consec_to   = env_u32("REDIS_CB_CONSECUTIVE_TIMEOUT_OPEN", 3);
        let err_open    = env_f64("REDIS_CB_ERROR_RATE_OPEN", 0.5);
        let to_open     = env_f64("REDIS_CB_TIMEOUT_RATE_OPEN", 0.4);
        let p99_open    = env_u64("REDIS_CB_P99_US_OPEN", 200_000);   // 200ms
        let p99_rec     = env_f64("REDIS_CB_P99_US_RECOVERY", 30_000.0); // 30ms
        let err_rec     = env_f64("REDIS_CB_ERROR_RATE_RECOVERY", 0.1);
        let cooldown    = env_u64("REDIS_CB_OPEN_COOLDOWN_MS", 5_000);
        let jitter      = env_u64("REDIS_CB_COOLDOWN_JITTER_MS", 2_000);
        let probes      = env_u32("REDIS_CB_HALF_OPEN_PROBES", 3);
        let rec_succ    = env_u32("REDIS_CB_RECOVERY_SUCCESSES", 3);
        let max_inf     = env_u64("REDIS_CB_MAX_INFLIGHT", 32) as i64;

        CbConfig {
            window_secs:           window_secs.clamp(1, 60),
            min_samples:           min_samples.clamp(5, 1_000),
            consecutive_fail_open: consec_fail.clamp(1, 100),
            consecutive_to_open:   consec_to.clamp(1, 100),
            error_rate_open:       err_open.clamp(0.0, 1.0),
            timeout_rate_open:     to_open.clamp(0.0, 1.0),
            p99_us_open:           p99_open.clamp(1_000, 60_000_000),
            p99_us_recovery:       p99_rec.clamp(1_000.0, 60_000_000.0),
            error_rate_recovery:   err_rec.clamp(0.0, 1.0),
            open_cooldown_ms:      cooldown.clamp(100, 300_000),
            cooldown_jitter_ms:    jitter.clamp(0, 60_000),
            half_open_probes:      probes.clamp(1, 20),
            recovery_successes:    rec_succ.clamp(1, 20),
            max_inflight:          max_inf.clamp(1, 10_000),
        }
    }
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
fn env_f64(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Rolling latency histogram (time-bucketed, memory-bounded)
//
// 10 one-second buckets. Each bucket stores:
//   - total latency in µs (sum)
//   - request count
//   - timeout count
//   - error count
//
// Percentiles are computed on demand by merging the non-stale buckets.
// We use fixed-width histograms per bucket (18 bands: 0..500µs up to 2s+).
// ─────────────────────────────────────────────────────────────────────────────

/// Number of latency histogram bands per time bucket.
const HIST_BANDS: usize = 18;

/// Upper bound (µs) for each band. Last band is open-ended (anything above).
const HIST_BOUNDS_US: [u64; HIST_BANDS - 1] = [
    500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000,
    100_000, 150_000, 200_000, 300_000, 400_000, 500_000,
    750_000, 1_000_000, 2_000_000,
];

const MAX_WINDOW_BUCKETS: usize = 64; // must be >= window_secs max (60)

/// A single one-second time bucket.
#[derive(Default)]
struct TimeBucket {
    ts:           AtomicU32,                    // Unix second this bucket covers
    total:        AtomicU64,                    // total requests
    errors:       AtomicU64,                    // error count
    timeouts:     AtomicU64,                    // timeout count
    latency_sum:  AtomicU64,                    // sum of latencies in µs
    hist:         [AtomicU64; HIST_BANDS],      // latency histogram
}

struct RollingWindow {
    buckets: Vec<TimeBucket>,
}

impl RollingWindow {
    fn new(size: usize) -> Self {
        let mut buckets = Vec::with_capacity(size);
        for _ in 0..size {
            buckets.push(TimeBucket::default());
        }
        Self { buckets }
    }

    fn current_ts() -> u32 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as u32
    }

    fn slot(&self, ts: u32) -> &TimeBucket {
        &self.buckets[(ts as usize) % self.buckets.len()]
    }

    /// Record one Redis call outcome in the appropriate time bucket.
    fn record(&self, outcome: RedisCallOutcome, latency_us: u64) {
        let ts = Self::current_ts();
        let b  = self.slot(ts);

        // Lazily clear the bucket when it belongs to a different second.
        let old_ts = b.ts.load(Ordering::Relaxed);
        if old_ts != ts && b.ts.compare_exchange(old_ts, ts, Ordering::AcqRel, Ordering::Relaxed).is_ok() {
            b.total.store(0, Ordering::Relaxed);
            b.errors.store(0, Ordering::Relaxed);
            b.timeouts.store(0, Ordering::Relaxed);
            b.latency_sum.store(0, Ordering::Relaxed);
            for h in b.hist.iter() {
                h.store(0, Ordering::Relaxed);
            }
        }

        b.total.fetch_add(1, Ordering::Relaxed);
        b.latency_sum.fetch_add(latency_us, Ordering::Relaxed);

        let band = HIST_BOUNDS_US.partition_point(|&bound| latency_us > bound);
        b.hist[band].fetch_add(1, Ordering::Relaxed);

        match outcome {
            RedisCallOutcome::RedisError => { b.errors.fetch_add(1, Ordering::Relaxed); }
            RedisCallOutcome::Timeout    => {
                b.timeouts.fetch_add(1, Ordering::Relaxed);
                b.errors.fetch_add(1, Ordering::Relaxed); // timeout is also an error
            }
            _ => {}
        }
    }

    /// Aggregate stats for the rolling window (ignores stale buckets).
    fn aggregate(&self, window_secs: u64) -> WindowStats {
        let now_ts = Self::current_ts();
        let cutoff = now_ts.saturating_sub(window_secs as u32);

        let mut total = 0u64;
        let mut errors = 0u64;
        let mut timeouts = 0u64;
        let mut hist = [0u64; HIST_BANDS];

        for b in self.buckets.iter() {
            let ts = b.ts.load(Ordering::Relaxed);
            if ts < cutoff || ts > now_ts {
                continue; // stale
            }
            total    += b.total.load(Ordering::Relaxed);
            errors   += b.errors.load(Ordering::Relaxed);
            timeouts += b.timeouts.load(Ordering::Relaxed);
            for (band, count) in b.hist.iter().enumerate() {
                hist[band] += count.load(Ordering::Relaxed);
            }
        }

        WindowStats { total, errors, timeouts, hist }
    }
}

struct WindowStats {
    total:    u64,
    errors:   u64,
    timeouts: u64,
    hist:     [u64; HIST_BANDS],
}

impl WindowStats {
    fn error_rate(&self) -> f64 {
        if self.total == 0 { 0.0 } else { self.errors as f64 / self.total as f64 }
    }

    fn timeout_rate(&self) -> f64 {
        if self.total == 0 { 0.0 } else { self.timeouts as f64 / self.total as f64 }
    }

    /// Compute the Nth percentile latency in µs from the histogram.
    fn percentile_us(&self, pct: f64) -> u64 {
        if self.total == 0 {
            return 0;
        }
        let target = (self.total as f64 * pct / 100.0).ceil() as u64;
        let mut cumulative = 0u64;
        for (i, &count) in self.hist.iter().enumerate() {
            cumulative += count;
            if cumulative >= target {
                return if i < HIST_BOUNDS_US.len() {
                    HIST_BOUNDS_US[i]
                } else {
                    u64::MAX
                };
            }
        }
        u64::MAX
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Circuit state machine
// ─────────────────────────────────────────────────────────────────────────────

const STATE_CLOSED:    u32 = 0;
const STATE_OPEN:      u32 = 1;
const STATE_HALF_OPEN: u32 = 2;

/// The circuit breaker — all state is process-local atomics.
pub struct CircuitBreaker {
    pub config:          CbConfig,
    state:               AtomicU32,
    /// Unix millisecond when the circuit opened (for cooldown).
    opened_at_ms:        AtomicU64,
    /// Actual cooldown for this OPEN cycle (base + jitter).
    cooldown_ms:         AtomicU64,
    /// Consecutive failures since last success.
    consecutive_fail:    AtomicU32,
    /// Consecutive timeouts since last success.
    consecutive_timeout: AtomicU32,
    /// Probes dispatched in HALF_OPEN (resets on each HALF_OPEN entry).
    probes_dispatched:   AtomicU32,
    /// Consecutive successes in HALF_OPEN.
    half_open_successes: AtomicU32,
    /// Rolling window for statistical detection.
    window:              RollingWindow,
    /// Redis operations currently in flight.
    inflight:            AtomicI64,

    // ── Prometheus-visible counters ───────────────────────────────────────────
    pub redis_requests_total:    AtomicU64,
    pub redis_success_total:     AtomicU64,
    pub redis_errors_total:      AtomicU64,
    pub redis_timeouts_total:    AtomicU64,
    pub circuit_open_total:      AtomicU64,
    pub circuit_half_open_total: AtomicU64,
    pub circuit_rejected_total:  AtomicU64,
}

impl CircuitBreaker {
    pub fn new(config: CbConfig) -> Self {
        let window_size = config.window_secs.clamp(1, MAX_WINDOW_BUCKETS as u64) as usize;
        Self {
            config,
            state:               AtomicU32::new(STATE_CLOSED),
            opened_at_ms:        AtomicU64::new(0),
            cooldown_ms:         AtomicU64::new(0),
            consecutive_fail:    AtomicU32::new(0),
            consecutive_timeout: AtomicU32::new(0),
            probes_dispatched:   AtomicU32::new(0),
            half_open_successes: AtomicU32::new(0),
            window:              RollingWindow::new(window_size),
            inflight:            AtomicI64::new(0),
            redis_requests_total:    AtomicU64::new(0),
            redis_success_total:     AtomicU64::new(0),
            redis_errors_total:      AtomicU64::new(0),
            redis_timeouts_total:    AtomicU64::new(0),
            circuit_open_total:      AtomicU64::new(0),
            circuit_half_open_total: AtomicU64::new(0),
            circuit_rejected_total:  AtomicU64::new(0),
        }
    }

    // ── §17 — Acquire: should we attempt a Redis call? ────────────────────────

    /// Returns true if the caller should proceed with the Redis operation.
    /// Returns false → caller must use degradation policy without calling Redis.
    pub fn acquire(&self) -> Result<(), RedisCallOutcome> {
        let cfg = &self.config;
        let state = self.state.load(Ordering::Acquire);

        match state {
            STATE_CLOSED => {
                // §15 — Concurrency protection
                let inflight = self.inflight.fetch_add(1, Ordering::AcqRel);
                if inflight >= cfg.max_inflight {
                    self.inflight.fetch_sub(1, Ordering::Relaxed);
                    self.circuit_rejected_total.fetch_add(1, Ordering::Relaxed);
                    return Err(RedisCallOutcome::ConcurrencyRejected);
                }
                Ok(())
            }

            STATE_OPEN => {
                // §3 — Check if cooldown has elapsed → transition to HALF_OPEN
                let now_ms = now_ms();
                let opened = self.opened_at_ms.load(Ordering::Relaxed);
                let cooldown = self.cooldown_ms.load(Ordering::Relaxed);

                if now_ms.saturating_sub(opened) >= cooldown {
                    // Attempt transition OPEN → HALF_OPEN
                    if self.state.compare_exchange(
                        STATE_OPEN, STATE_HALF_OPEN,
                        Ordering::AcqRel, Ordering::Relaxed,
                    ).is_ok() {
                        self.probes_dispatched.store(0, Ordering::Relaxed);
                        self.half_open_successes.store(0, Ordering::Relaxed);
                        self.circuit_half_open_total.fetch_add(1, Ordering::Relaxed);
                        eprintln!("[redis_cb] OPEN → HALF_OPEN (cooldown elapsed)");
                    }
                    // Whether we won or lost the CAS, fall through to HALF_OPEN logic below
                    return self.acquire_half_open();
                }

                // Circuit still open — reject
                self.circuit_rejected_total.fetch_add(1, Ordering::Relaxed);
                Err(RedisCallOutcome::CircuitOpen)
            }

            STATE_HALF_OPEN => self.acquire_half_open(),
            _ => Err(RedisCallOutcome::CircuitOpen),
        }
    }

    fn acquire_half_open(&self) -> Result<(), RedisCallOutcome> {
        let cfg = &self.config;
        // §18 — Only allow half_open_probes concurrent probe requests
        let dispatched = self.probes_dispatched.fetch_add(1, Ordering::AcqRel);
        if dispatched >= cfg.half_open_probes {
            self.probes_dispatched.fetch_sub(1, Ordering::Relaxed);
            self.circuit_rejected_total.fetch_add(1, Ordering::Relaxed);
            return Err(RedisCallOutcome::CircuitOpen);
        }
        let inflight = self.inflight.fetch_add(1, Ordering::AcqRel);
        if inflight >= cfg.half_open_probes as i64 {
            self.inflight.fetch_sub(1, Ordering::Relaxed);
            self.probes_dispatched.fetch_sub(1, Ordering::Relaxed);
            self.circuit_rejected_total.fetch_add(1, Ordering::Relaxed);
            return Err(RedisCallOutcome::ConcurrencyRejected);
        }
        Ok(())
    }

    // ── §19 — Release: record outcome and potentially change state ────────────

    /// Must be called after every Redis operation (paired with acquire).
    /// `latency_us` should be the wall-clock time of the Redis call.
    pub fn release(&self, outcome: RedisCallOutcome, latency_us: u64) {
        self.inflight.fetch_sub(1, Ordering::Relaxed);
        self.window.record(outcome, latency_us);
        self.redis_requests_total.fetch_add(1, Ordering::Relaxed);

        let cfg   = &self.config;
        let state = self.state.load(Ordering::Acquire);

        match outcome {
            RedisCallOutcome::Success => {
                self.redis_success_total.fetch_add(1, Ordering::Relaxed);
                self.consecutive_fail.store(0, Ordering::Relaxed);
                self.consecutive_timeout.store(0, Ordering::Relaxed);

                if state == STATE_HALF_OPEN {
                    let successes = self.half_open_successes.fetch_add(1, Ordering::AcqRel) + 1;
                    // §12 — Hysteresis: recovery requires sustained improvement,
                    // not just a couple of lucky successes.
                    let stats = self.window.aggregate(cfg.window_secs);
                    let p99   = stats.percentile_us(99.0) as f64;
                    if successes >= cfg.recovery_successes
                        && p99 <= cfg.p99_us_recovery
                        && stats.error_rate() <= cfg.error_rate_recovery
                        && self.state.compare_exchange(
                            STATE_HALF_OPEN, STATE_CLOSED,
                            Ordering::AcqRel, Ordering::Relaxed,
                        ).is_ok()
                    {
                        eprintln!("[redis_cb] HALF_OPEN → CLOSED (recovery confirmed, p99={p99:.0}µs, err_rate={:.2})", stats.error_rate());
                    }
                } else {
                    // §11 — Statistical detector (checks if p99 latency is degraded even on success)
                    self.check_statistical_open();
                }
            }

            RedisCallOutcome::Timeout => {
                self.redis_timeouts_total.fetch_add(1, Ordering::Relaxed);
                self.redis_errors_total.fetch_add(1, Ordering::Relaxed);
                let cf = self.consecutive_fail.fetch_add(1, Ordering::AcqRel) + 1;
                let ct = self.consecutive_timeout.fetch_add(1, Ordering::AcqRel) + 1;

                if state == STATE_HALF_OPEN {
                    self.trip_open("HALF_OPEN probe timeout");
                    return;
                }

                // Fast detector (§9)
                if ct >= cfg.consecutive_to_open || cf >= cfg.consecutive_fail_open {
                    self.trip_open(&format!("consecutive failures={cf} timeouts={ct}"));
                    return;
                }

                // Statistical detector (§11)
                self.check_statistical_open();
            }

            RedisCallOutcome::RedisError => {
                self.redis_errors_total.fetch_add(1, Ordering::Relaxed);
                let cf = self.consecutive_fail.fetch_add(1, Ordering::AcqRel) + 1;

                if state == STATE_HALF_OPEN {
                    self.trip_open("HALF_OPEN probe failed");
                    return;
                }

                // Fast detector
                if cf >= cfg.consecutive_fail_open {
                    self.trip_open(&format!("consecutive failures={cf}"));
                    return;
                }

                // Statistical detector
                self.check_statistical_open();
            }

            // CircuitOpen / ConcurrencyRejected are never passed to release().
            _ => {}
        }
    }

    // ── §11 — Statistical detector ────────────────────────────────────────────

    fn check_statistical_open(&self) {
        let cfg = &self.config;
        let stats = self.window.aggregate(cfg.window_secs);

        // §10 — Minimum sample size before statistical decisions
        if stats.total < cfg.min_samples {
            return;
        }

        let err_rate = stats.error_rate();
        let to_rate  = stats.timeout_rate();
        let p99      = stats.percentile_us(99.0);

        let should_open =
            err_rate >= cfg.error_rate_open
            || to_rate >= cfg.timeout_rate_open
            || p99 >= cfg.p99_us_open;

        if should_open {
            self.trip_open(&format!(
                "rolling stats: err_rate={err_rate:.2} timeout_rate={to_rate:.2} p99={p99}µs"
            ));
        }
    }

    // ── State transition: → OPEN ──────────────────────────────────────────────

    fn trip_open(&self, reason: &str) {
        let cfg = &self.config;

        // Jitter: prevents all gateway instances from recovering at exactly the
        // same time (fleet-level recovery storm — §20, §21).
        let jitter_ms = if cfg.cooldown_jitter_ms > 0 {
            // Cheap pseudo-random: mix of process id + current time
            let seed = (std::process::id() as u64)
                .wrapping_mul(6364136223846793005)
                .wrapping_add(now_ms());
            (seed >> 33) % cfg.cooldown_jitter_ms
        } else {
            0
        };
        let effective_cooldown = cfg.open_cooldown_ms + jitter_ms;

        if self.state.compare_exchange(
            self.state.load(Ordering::Acquire),
            STATE_OPEN,
            Ordering::AcqRel,
            Ordering::Relaxed,
        ).is_ok() {
            self.opened_at_ms.store(now_ms(), Ordering::Relaxed);
            self.cooldown_ms.store(effective_cooldown, Ordering::Relaxed);
            self.circuit_open_total.fetch_add(1, Ordering::Relaxed);
            eprintln!(
                "[redis_cb] → OPEN: {reason} (cooldown={effective_cooldown}ms)"
            );
        }
    }

    // ── State query ───────────────────────────────────────────────────────────

    pub fn state(&self) -> u32 {
        self.state.load(Ordering::Acquire)
    }

    pub fn is_closed(&self) -> bool {
        self.state() == STATE_CLOSED
    }

    pub fn inflight_count(&self) -> i64 {
        self.inflight.load(Ordering::Relaxed)
    }

    /// p99 latency in µs from the rolling window (for Prometheus).
    pub fn p99_us(&self) -> u64 {
        let cfg = &self.config;
        self.window.aggregate(cfg.window_secs).percentile_us(99.0)
    }

    /// Current error rate from the rolling window (for Prometheus).
    pub fn error_rate(&self) -> f64 {
        let cfg = &self.config;
        self.window.aggregate(cfg.window_secs).error_rate()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Process-global circuit breaker instance
//
// One per NGINX worker process. Not shared across processes — each worker
// independently determines Redis health. This is the correct design (§4, §27).
// ─────────────────────────────────────────────────────────────────────────────

static REDIS_CB: OnceLock<CircuitBreaker> = OnceLock::new();

pub fn get_cb() -> &'static CircuitBreaker {
    REDIS_CB.get_or_init(|| {
        CircuitBreaker::new(CbConfig::from_env())
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Public helper — wraps a Redis call with circuit-breaker protection.
//
// Usage:
//   let result = with_circuit_breaker(|| {
//       // your synchronous Redis call here
//       my_redis_conn.cmd("EXISTS", &[key])
//   });
//   match result {
//       Ok(value) => { /* use value */ }
//       Err(RedisCallOutcome::CircuitOpen) => { /* degrade */ }
//       Err(RedisCallOutcome::Timeout)     => { /* degrade */ }
//       Err(RedisCallOutcome::RedisError)  => { /* degrade */ }
//       Err(_)                             => { /* degrade */ }
//   }
// ─────────────────────────────────────────────────────────────────────────────

/// Execute `f` under circuit-breaker protection.
///
/// - If the circuit is OPEN or concurrency limit exceeded, returns immediately
///   with the appropriate `Err(RedisCallOutcome)` without calling `f`.
/// - If the circuit is CLOSED/HALF_OPEN, calls `f`, measures latency, records
///   the outcome, and returns the result.
/// - `f` must classify its own error as either Timeout or RedisError via
///   `classify_redis_error`.
pub fn with_circuit_breaker<T, F>(f: F) -> Result<T, RedisCallOutcome>
where
    F: FnOnce() -> Result<T, RedisCallOutcome>,
{
    let cb = get_cb();

    // Acquire: check state + concurrency
    cb.acquire()?;

    let start = Instant::now();
    let result = f();
    let latency_us = start.elapsed().as_micros() as u64;

    let outcome = match &result {
        Ok(_)                                                   => RedisCallOutcome::Success,
        Err(RedisCallOutcome::Timeout)                         => RedisCallOutcome::Timeout,
        Err(RedisCallOutcome::RedisError)                      => RedisCallOutcome::RedisError,
        Err(RedisCallOutcome::CircuitOpen)                     => RedisCallOutcome::CircuitOpen,
        Err(RedisCallOutcome::ConcurrencyRejected)             => RedisCallOutcome::ConcurrencyRejected,
        Err(_)                                                 => RedisCallOutcome::RedisError,
    };

    cb.release(outcome, latency_us);

    result
}

/// Classify a `redis::RedisError` as Timeout or RedisError (§7).
pub fn classify_redis_error(e: &redis::RedisError) -> RedisCallOutcome {
    use redis::ErrorKind;
    match e.kind() {
        ErrorKind::IoError => {
            // IO errors from the redis crate include both timeouts and connection
            // resets. Check the inner message for "timed out".
            if e.to_string().contains("timed out") || e.to_string().contains("WouldBlock") {
                RedisCallOutcome::Timeout
            } else {
                RedisCallOutcome::RedisError
            }
        }
        // These are Redis-server-level responses, not network infrastructure failures.
        ErrorKind::ResponseError
        | ErrorKind::TypeError
        | ErrorKind::ExecAbortError
        | ErrorKind::BusyLoadingError => RedisCallOutcome::RedisError,
        // Everything else (auth, host resolution, etc.)
        _ => RedisCallOutcome::RedisError,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests (§28)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn fresh_cb() -> CircuitBreaker {
        CircuitBreaker::new(CbConfig::from_env())
    }

    fn custom_cb(modify: impl FnOnce(&mut CbConfig)) -> CircuitBreaker {
        let mut cfg = CbConfig::from_env();
        modify(&mut cfg);
        CircuitBreaker::new(cfg)
    }

    // Test 1: Healthy Redis — circuit stays CLOSED
    #[test]
    fn healthy_redis_stays_closed() {
        let cb = fresh_cb();
        for _ in 0..100 {
            cb.acquire().unwrap();
            cb.release(RedisCallOutcome::Success, 500);
        }
        assert_eq!(cb.state(), STATE_CLOSED);
    }

    // Test 2: Single transient failure — stays CLOSED
    #[test]
    fn one_failure_stays_closed() {
        let cb = fresh_cb();
        cb.acquire().unwrap();
        cb.release(RedisCallOutcome::Success, 500);
        cb.acquire().unwrap();
        cb.release(RedisCallOutcome::RedisError, 1000);
        cb.acquire().unwrap();
        cb.release(RedisCallOutcome::Success, 500);
        assert_eq!(cb.state(), STATE_CLOSED);
    }

    // Test 3: Consecutive failures reach threshold → OPEN
    #[test]
    fn consecutive_failures_open_circuit() {
        let cb = custom_cb(|cfg| {
            cfg.consecutive_fail_open = 3;
            cfg.min_samples = 100;
        });
        for _ in 0..3 {
            cb.acquire().unwrap();
            cb.release(RedisCallOutcome::RedisError, 100);
        }
        assert_eq!(cb.state(), STATE_OPEN);
    }

    // Test 4: High timeout rate → OPEN
    #[test]
    fn high_timeout_rate_opens_circuit() {
        let cb = custom_cb(|cfg| {
            cfg.timeout_rate_open = 0.4;
            cfg.min_samples = 5;
            cfg.consecutive_fail_open = 100;
            cfg.consecutive_to_open = 100;
        });
        // 3 timeouts + 2 successes = 60% timeout rate > 40% threshold
        for _ in 0..2 {
            cb.acquire().unwrap();
            cb.release(RedisCallOutcome::Success, 500);
        }
        for _ in 0..3 {
            cb.acquire().unwrap();
            cb.release(RedisCallOutcome::Timeout, 50_000);
        }
        assert_eq!(cb.state(), STATE_OPEN);
    }

    // Test 5: High error rate → OPEN
    #[test]
    fn high_error_rate_opens_circuit() {
        let cb = custom_cb(|cfg| {
            cfg.error_rate_open = 0.5;
            cfg.min_samples = 4;
            cfg.consecutive_fail_open = 100;
            cfg.consecutive_to_open = 100;
        });
        for _ in 0..2 {
            cb.acquire().unwrap();
            cb.release(RedisCallOutcome::Success, 500);
        }
        for _ in 0..2 {
            cb.acquire().unwrap();
            cb.release(RedisCallOutcome::RedisError, 1000);
        }
        assert_eq!(cb.state(), STATE_OPEN);
    }

    // Test 7: Low request volume — circuit does not open on tiny sample
    #[test]
    fn low_volume_does_not_open() {
        let cb = custom_cb(|cfg| {
            cfg.min_samples = 20;
            cfg.consecutive_fail_open = 100;
        });
        for _ in 0..3 {
            cb.acquire().unwrap();
            cb.release(RedisCallOutcome::RedisError, 1000);
        }
        // 3 errors but only 3 samples < min_samples=20, stat detector silent
        // and consecutive < threshold
        assert_eq!(cb.state(), STATE_CLOSED);
    }

    // Test 8: OPEN — Redis not called (acquire returns CircuitOpen)
    #[test]
    fn open_circuit_rejects_acquire() {
        let cb = custom_cb(|cfg| {
            cfg.consecutive_fail_open = 2;
            cfg.min_samples = 100;
        });
        for _ in 0..2 {
            cb.acquire().unwrap();
            cb.release(RedisCallOutcome::RedisError, 100);
        }
        assert_eq!(cb.state(), STATE_OPEN);
        let result = cb.acquire();
        assert_eq!(result, Err(RedisCallOutcome::CircuitOpen));
    }

    // Test 11: Successful probes → HALF_OPEN → CLOSED
    #[test]
    fn half_open_success_recovers() {
        let cb = custom_cb(|cfg| {
            cfg.consecutive_fail_open = 2;
            cfg.min_samples = 100;
            cfg.half_open_probes = 3;
            cfg.recovery_successes = 3;
            cfg.p99_us_recovery = 1_000_000.0;
            cfg.error_rate_recovery = 1.0;
            cfg.open_cooldown_ms = 1;
            cfg.cooldown_jitter_ms = 0;
        });

        // Trip the circuit
        for _ in 0..2 {
            cb.acquire().unwrap();
            cb.release(RedisCallOutcome::RedisError, 100);
        }
        assert_eq!(cb.state(), STATE_OPEN);

        // Wait for cooldown
        std::thread::sleep(Duration::from_millis(5));

        // Probe — should transition to HALF_OPEN on first acquire
        for _ in 0..3 {
            let r = cb.acquire();
            if r.is_ok() {
                cb.release(RedisCallOutcome::Success, 500);
            }
        }
        // After enough successes should be CLOSED
        assert_eq!(cb.state(), STATE_CLOSED);
    }

    // Test 12: Failed probe → HALF_OPEN → OPEN
    #[test]
    fn half_open_failure_returns_to_open() {
        let cb = custom_cb(|cfg| {
            cfg.consecutive_fail_open = 2;
            cfg.min_samples = 100;
            cfg.half_open_probes = 3;
            cfg.open_cooldown_ms = 1;
            cfg.cooldown_jitter_ms = 0;
        });

        for _ in 0..2 {
            cb.acquire().unwrap();
            cb.release(RedisCallOutcome::RedisError, 100);
        }
        assert_eq!(cb.state(), STATE_OPEN);

        std::thread::sleep(Duration::from_millis(5));

        // Single failed probe should re-open
        if let Ok(()) = cb.acquire() {
            cb.release(RedisCallOutcome::RedisError, 100);
        }
        assert_eq!(cb.state(), STATE_OPEN);
    }

    // Test 15: Concurrency limit
    #[test]
    fn concurrency_limit_respected() {
        let cb = custom_cb(|cfg| {
            cfg.max_inflight = 2;
        });
        // Acquire 2 — both succeed
        cb.acquire().expect("first acquire should succeed");
        cb.acquire().expect("second acquire should succeed");
        // Third should be rejected
        assert_eq!(cb.acquire(), Err(RedisCallOutcome::ConcurrencyRejected));
    }

    // Latency percentile sanity check
    #[test]
    fn percentile_computed_correctly() {
        let window = RollingWindow::new(10);
        // Record 100 requests: 90 at 1ms, 10 at 500ms
        for _ in 0..90 {
            window.record(RedisCallOutcome::Success, 1_000);  // 1ms
        }
        for _ in 0..10 {
            window.record(RedisCallOutcome::Success, 500_000); // 500ms
        }
        let stats = window.aggregate(10);
        let p50 = stats.percentile_us(50.0);
        let p99 = stats.percentile_us(99.0);
        // p50 should be in the 1ms band
        assert!(p50 <= 2_000, "p50={p50}µs, expected ≤2ms");
        // p99 should be in the 500ms band
        assert!(p99 >= 400_000, "p99={p99}µs, expected ≥400ms");
    }

    // Error rate sanity check
    #[test]
    fn error_rate_computed_correctly() {
        let window = RollingWindow::new(10);
        for _ in 0..8 {
            window.record(RedisCallOutcome::Success, 500);
        }
        for _ in 0..2 {
            window.record(RedisCallOutcome::RedisError, 500);
        }
        let stats = window.aggregate(10);
        let rate = stats.error_rate();
        assert!((rate - 0.2).abs() < 0.01, "error_rate={rate}");
    }

    // Circuit breaker state is 0 (CLOSED) on init
    #[test]
    fn initial_state_is_closed() {
        let cb = fresh_cb();
        assert_eq!(cb.state(), STATE_CLOSED);
        assert!(cb.is_closed());
    }

    // Test 6 (§28): High p99 latency sustained → OPEN
    #[test]
    fn high_p99_latency_opens_circuit() {
        let cb = custom_cb(|cfg| {
            cfg.p99_us_open = 100_000; // 100ms
            cfg.min_samples = 10;
            cfg.consecutive_fail_open = 100;
            cfg.consecutive_to_open = 100;
        });
        // 9 requests at 1ms, 1 at 200ms -> p99 is in the 200ms band > 100ms threshold
        for _ in 0..9 {
            cb.acquire().unwrap();
            cb.release(RedisCallOutcome::Success, 1_000);
        }
        cb.acquire().unwrap();
        cb.release(RedisCallOutcome::Success, 200_000);
        assert_eq!(cb.state(), STATE_OPEN);
    }

    // Test 13 (§28): Recovery Hysteresis — circuit does not flap if p99 remains above recovery threshold
    #[test]
    fn recovery_hysteresis_prevents_flapping() {
        let cb = custom_cb(|cfg| {
            cfg.consecutive_fail_open = 2;
            cfg.min_samples = 100;
            cfg.half_open_probes = 3;
            cfg.recovery_successes = 2;
            cfg.p99_us_recovery = 10_000.0; // 10ms recovery threshold
            cfg.error_rate_recovery = 0.1;
            cfg.open_cooldown_ms = 1;
            cfg.cooldown_jitter_ms = 0;
        });

        // Trip the circuit
        for _ in 0..2 {
            cb.acquire().unwrap();
            cb.release(RedisCallOutcome::RedisError, 100);
        }
        assert_eq!(cb.state(), STATE_OPEN);

        std::thread::sleep(Duration::from_millis(5));

        // Send probes with high latency (50ms) > recovery threshold (10ms)
        for _ in 0..2 {
            if cb.acquire().is_ok() {
                cb.release(RedisCallOutcome::Success, 50_000); // 50ms latency
            }
        }
        // Should remain in HALF_OPEN because p99 exceeds recovery threshold (hysteresis)
        assert_eq!(cb.state(), STATE_HALF_OPEN);
    }

    // Test 14 (§28): Recovery jitter — cooldown delay is non-negative and bounded
    #[test]
    fn recovery_jitter_bounded() {
        let cb = custom_cb(|cfg| {
            cfg.consecutive_fail_open = 1;
            cfg.open_cooldown_ms = 100;
            cfg.cooldown_jitter_ms = 500;
        });
        cb.acquire().unwrap();
        cb.release(RedisCallOutcome::RedisError, 100);
        assert_eq!(cb.state(), STATE_OPEN);

        let effective_cooldown = cb.cooldown_ms.load(Ordering::Relaxed);
        assert!((100..=600).contains(&effective_cooldown), "cooldown={effective_cooldown}");
    }

    // Test 15 & 20 (§28): Concurrent state transitions & context isolation
    #[test]
    fn concurrent_threads_state_isolation() {
        use std::sync::Arc;
        let cb = Arc::new(custom_cb(|cfg| {
            cfg.max_inflight = 100;
            cfg.consecutive_fail_open = 1000;
        }));

        let mut handles = vec![];
        for _ in 0..8 {
            let cb_clone = Arc::clone(&cb);
            handles.push(std::thread::spawn(move || {
                for i in 0..100 {
                    if cb_clone.acquire().is_ok() {
                        let outcome = if i % 10 == 0 {
                            RedisCallOutcome::RedisError
                        } else {
                            RedisCallOutcome::Success
                        };
                        cb_clone.release(outcome, 500);
                    }
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(cb.inflight_count(), 0, "inflight leak check");
        assert_eq!(cb.redis_requests_total.load(Ordering::Relaxed), 800);
    }
}
