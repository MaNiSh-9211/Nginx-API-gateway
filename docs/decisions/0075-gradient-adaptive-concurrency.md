# ADR-0075: Gradient Adaptive Concurrency Limiter

## Status: Accepted

## Context
Every gateway hardcodes max_connections=N. That N goes stale when traffic patterns shift, backend capacity changes, or a deploy lands.

## Decision
Applies the TCP Vegas algorithm to the HTTP proxy layer. Each upstream gets a GradientLimiter that tracks expected latency (limit x min_rtt) vs observed RTT. When the queue builds, the limit shrinks; with headroom, it grows. Zero configuration.

## Consequences
* Limit self-discovers backend carrying capacity
* Lock-free atomics; hot-path cost ~3 atomic loads + 1 CAS
* Per-worker instances converge independently (local-only philosophy)
