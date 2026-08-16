# ADR-0008 — Per-upstream + global circuit breaker

**Status:** Accepted

## Context

When an upstream is failing or slow, blindly forwarding traffic wastes resources,
piles up latency, and can cascade into a node-wide brownout. We need to detect
failure fast, stop hammering the bad dependency, and probe for recovery — without
locks on the hot path.

## Decision

A **lock-free state machine** (`closed → open → half-open → closed`) backed by
shared-memory atomics (ADR-0004), tracked **per upstream** and **globally**:

- `report_telemetry` (log phase) feeds each response's status into the breaker:
  5xx → failure, else success.
- After a failure threshold, the breaker **opens**: the load balancer skips that
  upstream (ADR-0009); the global breaker also tightens admission (ADR-0010).
- After a cooldown it goes **half-open**, allowing a limited probe; success
  closes it, failure re-opens it.
- State is exported as `gateway_circuit_breaker_state` for alerting (ADR-0015).

## Alternatives considered

- **Retries without a breaker.** Retries alone amplify load on an already-failing
  upstream (retry storms) and hurt tail latency. A breaker is the correct
  primary control; retries (if added) must be budgeted and breaker-aware.
- **Client-library breakers only (e.g. per-SDK).** We sit in front of many
  clients; centralizing the breaker at the gateway gives one consistent policy
  and shared signal across all callers.
- **Health-check-only (active probing).** Useful but lags real traffic; passive,
  traffic-driven breaking reacts to actual error/latency the moment it happens.
  The two are complementary; we lead with passive.

## Consequences

- Fast failure isolation and automatic, controlled recovery.
- Composes with the LB (skip open upstreams) and backpressure (global breaker
  shrinks capacity to 10% when half-open, rejects when open).
- Cost: thresholds/cooldowns are tunables that need sane defaults and, ideally,
  per-service tuning; a flapping upstream can oscillate (mitigated by the
  half-open probe limit and EMA latency signal).
