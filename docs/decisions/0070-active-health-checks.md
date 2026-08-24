# ADR-0070: Active Health Checks

## Status: Accepted

## Context
Passive health detection (failure counting on real traffic) means recovered upstreams receive no traffic until someone tries them.

## Decision
Per-worker prober thread walks configured upstreams every interval, probes `{scheme}://{addr}{path}`, and maintains per-address UP/DOWN flags in cross-worker SHM. Threshold-based transitions (N fails -> DOWN, M oks -> UP). Selector requires both passive CB closed AND active probes healthy.

## Consequences
* Auto-recovery without traffic
* Cross-worker instant consistency via SHM
* Late-config activation (waits for sidecar delivery)
