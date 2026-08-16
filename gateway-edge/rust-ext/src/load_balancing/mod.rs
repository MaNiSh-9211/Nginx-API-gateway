//! Gateway load balancing — dedicated module.
//!
//! Strategy (production pattern used at Meta/Google/AWS scale):
//!   1. **Weighted consistent hash** — session/cache affinity on `user_id`
//!   2. **Power-of-two-choices (P2C)** — compare two hash-derived candidates
//!   3. **EWMA latency** — pick the healthier/faster upstream when load diverges
//!   4. **Circuit breaker** — skip unhealthy upstreams; walk ring on failover
//!
//! See ADR-0009 and `docs/decisions/0009-load-balancing-consistent-hash-ema.md`.

pub mod circuit_breaker;
mod ema;
mod ring;
mod selector;

pub use circuit_breaker::{
    global_state, record_failure, record_failure_for, record_success,
    record_success_for, STATE_CLOSED, STATE_HALF_OPEN,
};
pub use ema::record_upstream_latency;
pub use selector::select_upstream;
