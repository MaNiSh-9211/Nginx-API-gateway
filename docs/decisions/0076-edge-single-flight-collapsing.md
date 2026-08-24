# ADR-0076: Edge-Level Single-Flight Request Collapsing

## Status: Accepted

## Context
100 concurrent identical GET requests produce 100 backend hits when cache is cold. Every gateway cleans up after this thundering herd.

## Decision
Collapse at the source: first request becomes leader and proxies; others register as followers keyed by (method+path+query). Leader publishes result, all followers receive it simultaneously. Only GET/HEAD collapsed.

## Consequences
* Eliminates thundering herd at the proxy level
* FxHashMap + Arc<Mutex<Option<i32>>> for zero-allocation followers
* Bounded 2s spin-wait prevents deadlock if leader crashes
