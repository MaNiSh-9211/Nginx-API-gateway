# ADR-0072: Soft Circuit Breaker — Confidence-Scored Routing

## Status: Accepted

## Context
Binary open/closed circuit breakers create cliff-edge behavior: upstreams get full traffic or zero traffic with no middle ground.

## Decision
`get_confidence()` computes a 0–100 score per upstream from existing SHM counters. The P2C selector penalizes latency EMA by low confidence (`score = EMA × (1 + deficit/50)`), creating continuous traffic weighting instead of binary ejection.

## Consequences
* Graceful degradation instead of cliff-edge rejection
* Recovery becomes proportional re-trust rather than full flip
* Zero additional SHM; derived from existing counters
