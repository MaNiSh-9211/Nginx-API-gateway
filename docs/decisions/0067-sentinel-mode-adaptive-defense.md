# ADR-0071: Sentinel Mode — Adaptive Defense Posture

## Status: Accepted

## Context
Gateway defenses (WAF, circuit breakers, rate limits, health checks) operate independently. No single component knows the overall threat level.

## Decision
A Sentinel thread fuses five signals (upstream health ratio, CB state, WAF block velocity, 5xx rate, backpressure saturation) into a hysteresis state machine with four posture levels (L0 Normal → L4 Lockdown). Thresholds self-calibrate via median+MAD baselines over rolling windows. Effects escalate from WAF budget halving (L2) through anonymous shedding (L3) to authenticated-only lockdown (L4).

## Consequences
* Zero-tuning adaptive defense that responds to real conditions
* Cross-worker via shared atomic posture byte (~1 ns read)
* Decay is gradual (one level/clean minute) preventing oscillation
