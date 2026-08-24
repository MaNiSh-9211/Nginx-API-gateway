# ADR-0077: Latency Debt Ledger

## Status: Accepted

## Context
Circuit breakers watch for failures (5xx, timeouts). But the most dangerous degradation is silent slowdown: backend returns 200 OK in 3 seconds instead of 30ms. No breaker trips. No alert fires.

## Decision
Each upstream accumulates debt when responses exceed their tier's time budget. Debt is stored in cross-worker SHM, decays exponentially (30s half-life), and creates a natural credit market where backends earn traffic by being consistently fast. The LB selector can factor debt into routing decisions.

## Consequences
* Catches silent slowdown before it becomes user-visible
* Creates gradient pressure instead of binary rejection
* Cross-worker SHM ensures instant consistency across workers
