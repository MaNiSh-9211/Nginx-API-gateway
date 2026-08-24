//! Sentinel Mode (ADR-0071) — the gateway's adaptive immune system.
//!
//! ┌────────────────────────────────────────────────────────────────────────┐
//! │ Every gateway ships isolated defenses: a WAF here, a circuit breaker   │
//! │ there, rate limits somewhere else. None of them talk to each other.    │
//! │ Sentinel couples ALL defensive signals into ONE hysteresis state       │
//! │ machine that raises the node's posture under attack and relaxes it     │
//! │ as conditions clean up — like an immune response, not individual       │
//! │ white blood cells fighting alone.                                      │
//! └────────────────────────────────────────────────────────────────────────┘
//!
//! Signals fused (sampled every second):
//!   * upstream health ratio      (active probes, ADR-0061)
//!   * global circuit state       (passive failure CB)
//!   * WAF block velocity         (blocks/min, rolling)
//!   * 5xx velocity               (edge telemetry counters, rolling)
//!   * backpressure saturation    (in-flight / max concurrency)
//!
//! Posture levels (hysteresis — raise instantly on ANY trigger, decay one
//! level per clean minute):
//!   L0 NORMAL        baseline behavior
//!   L2 ELEVATED      WAF per-IP budget halved
//!   L3 GUARDED       + anonymous requests shed (auth-required everywhere)
//!   L4 LOCKDOWN      + only authenticated traffic admitted at all
//!
//! Effects are read cross-worker through one atomic byte (~1 ns on hot path).
//! This is deliberately LOCAL per node — no coordination, same philosophy as
//! the circuit breakers (a DDoS on one PoP must not blind the others).

use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use arc_swap::ArcSwap;

use crate::config::GLOBAL_CONFIG;
use crate::health;
use crate::load_balancing;
use crate::rate_limit;
use crate::telemetry;

// ── Posture ───────────────────────────────────────────────────────────────────

pub const L0_NORMAL: u8 = 0;
pub const L2_ELEVATED: u8 = 2;
pub const L3_GUARDED: u8 = 3;
pub const L4_LOCKDOWN: u8 = 4;

static POSTURE: AtomicU8 = AtomicU8::new(0);
static POSTURE_SINCE_MS: AtomicU64 = AtomicU64::new(0);
pub static TRANSITIONS_TOTAL: AtomicU64 = AtomicU64::new(0);

/// Hot-path read: current posture level (0/2/3/4).
#[inline]
pub fn level() -> u8 {
    POSTURE.load(Ordering::Relaxed)
}

/// True when unauthenticated requests should be shed (L3+).
#[inline]
pub fn shed_anonymous() -> bool {
    POSTURE.load(Ordering::Relaxed) >= L3_GUARDED
}

/// Multiplier applied to the WAF per-IP request budget (L2+ tightens it).
#[inline]
pub fn waf_budget_factor() -> f64 {
    match POSTURE.load(Ordering::Relaxed) {
        l if l >= L4_LOCKDOWN => 0.25,
        l if l >= L2_ELEVATED => 0.5,
        _ => 1.0,
    }
}

fn set_level(new: u8, reason: &str) -> bool {
    let old = POSTURE.swap(new, Ordering::AcqRel);
    if old != new {
        POSTURE_SINCE_MS.store(now_ms(), Ordering::Release);
        TRANSITIONS_TOTAL.fetch_add(1, Ordering::Relaxed);
        eprintln!(
            "[sentinel] L{old} -> L{new} ({reason}) — effects: waf_x{:.2}{}",
            waf_budget_factor(),
            if new >= L3_GUARDED { ", anon-shed ON" } else { "" },
        );
        true
    } else {
        false
    }
}

// ── Signal snapshot (pure, unit-tested) ──────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Signals {
    /// Fraction of configured upstreams currently probed-DOWN [0.0..1.0].
    pub down_ratio: f64,
    /// Passive global CB state (0 closed / 1 open / 2 half-open).
    pub global_cb_state: u8,
    /// WAF blocks observed in the last sample window.
    pub waf_blocks: u64,
    /// 5xx responses observed in the last sample window.
    pub server_errors: u64,
    /// Total requests in the last sample window (denominator guard).
    pub requests: u64,
    /// Backpressure saturation fraction [0.0..1.0].
    pub saturation: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Thresholds {
    pub down_ratio_major: f64,   // default 0.5 → L3+
    pub down_ratio_minor: f64,   // default 0.25 → L2
    pub error_rate_major: f64,   // default 0.20 → L3
    pub error_rate_minor: f64,   // default 0.05 → L2
    pub waf_blocks_major: u64,   // default 200/min → L3
    pub waf_blocks_minor: u64,   // default 50/min  → L2
    pub saturation_major: f64,   // default 0.95 → L3
    pub saturation_minor: f64,   // default 0.80 → L2
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            down_ratio_major: 0.5,
            down_ratio_minor: 0.25,
            error_rate_major: 0.20,
            error_rate_minor: 0.05,
            waf_blocks_major: 200,
            waf_blocks_minor: 50,
            saturation_major: 0.95,
            saturation_minor: 0.80,
        }
    }
}

/// Compute target posture from signals. Pure — fully unit-tested.
pub fn compute_target(s: &Signals, t: &Thresholds) -> u8 {
    let err_rate = if s.requests > 0 { s.server_errors as f64 / s.requests as f64 } else { 0.0 };

    let mut triggers_major = 0u32;
    let mut triggers_minor = 0u32;

    if s.down_ratio >= t.down_ratio_major || (s.requests > 100 && err_rate >= t.error_rate_major) {
        triggers_major += 1;
    } else if s.down_ratio >= t.down_ratio_minor || (s.requests > 100 && err_rate >= t.error_rate_minor) {
        triggers_minor += 1;
    }
    if s.global_cb_state == 1 {
        triggers_minor += 1; // open passive CB = dependency storm in progress
    }
    if s.waf_blocks >= t.waf_blocks_major {
        triggers_major += 1;
    } else if s.waf_blocks >= t.waf_blocks_minor {
        triggers_minor += 1;
    }
    if s.saturation >= t.saturation_major {
        triggers_major += 1;
    } else if s.saturation >= t.saturation_minor {
        triggers_minor += 1;
    }

    if triggers_major > 0 {
        if triggers_major >= 2 || s.down_ratio >= t.down_ratio_major {
            L4_LOCKDOWN
        } else {
            L3_GUARDED
        }
    } else if triggers_minor >= 2 {
        L3_GUARDED
    } else if triggers_minor == 1 {
        L2_ELEVATED
    } else {
        L0_NORMAL
    }
}

// ── Sampling thread ───────────────────────────────────────────────────────────

static STARTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();

pub fn start_sentinel() {
    let _ = STARTED.set(());
    let _ = std::thread::Builder::new()
        .name("sentinel".into())
        .spawn(sentinel_loop);
}

fn sentinel_loop() {
    let thresholds = Thresholds::default();
    let mut prev_waf: u64 = 0;
    let mut prev_5xx: u64 = 0;
    let mut prev_req: u64 = 0;
    let mut last_raise_ms: u64 = 0;
    let mut clean_minutes: u32 = 0;

    loop {
        std::thread::sleep(Duration::from_secs(1));

        // ── Sample signals ────────────────────────────────────────────────
        let now_ms = now_ms();
        let snap = telemetry::snapshot();
        let waf_total = crate::waf::waf_blocks_total();

        let waf_delta = waf_total.saturating_sub(prev_waf);
        let err_delta = snap.requests_5xx.saturating_sub(prev_5xx);
        let req_delta = snap.requests_total.saturating_sub(prev_req);
        prev_waf = waf_total;
        prev_5xx = snap.requests_5xx;
        prev_req = snap.requests_total;

        let down_ratio = health::down_ratio();
        let cb_state = load_balancing::global_state() as u8;
        let saturation = backpressure_saturation();

        let signals = Signals {
            down_ratio,
            global_cb_state: cb_state,
            waf_blocks: waf_delta,
            server_errors: err_delta,
            requests: req_delta,
            saturation,
        };

        // ── Hysteresis state update ───────────────────────────────────────
        let current = POSTURE.load(Ordering::Relaxed);
        let target = compute_target(&signals, &thresholds);

        if target > current {
            // Raise instantly on any escalation.
            let reason = format!(
                "down={:.2} cb={} waf={} 5xx={} sat={:.2}",
                down_ratio, cb_state, waf_delta, err_delta, saturation
            );
            if set_level(target, &reason) {
                last_raise_ms = now_ms;
                clean_minutes = 0;
            }
        } else if target < current {
            // Decay one level per clean minute once the raise has settled.
            let settled = now_ms.saturating_sub(last_raise_ms) >= 60_000
                && now_ms.saturating_sub(POSTURE_SINCE_MS.load(Ordering::Acquire)) >= 60_000;
            if settled {
                clean_minutes += 1;
                if clean_minutes >= 1 {
                    let next = (current - 1).max(target);
                    set_level(next, "decay (signals clean)");
                    clean_minutes = 0;
                }
            }
        }
    }
}

fn backpressure_saturation() -> f64 {
    // Read via FFI-visible helpers when available; fall back to config max.
    let max = GLOBAL_CONFIG.load().global_max_concurrency.max(1) as f64;
    let inflight = crate::backpressure::current_in_flight() as f64;
    (inflight / max).min(1.5)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
