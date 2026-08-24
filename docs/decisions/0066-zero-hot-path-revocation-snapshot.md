# ADR-0066: Zero-Hot-Path Revocation Snapshot

## Status: Accepted

## Context
Token revocation checks required a Redis round-trip per request (~200-400ms TLS to Upstash), making the hot path network-dependent for auth.

## Decision
Each worker maintains an in-memory revocation snapshot via `arc-swap`, refreshed every `AUTH_SNAPSHOT_SYNC_SECS` (default 5s) by a background thread pulling deltas from Redis ZSET indexes. Publishers (control-plane, uam) maintain the index alongside the legacy keys.

## Consequences
* Hot-path auth cost drops from ~200ms to ~100ns
* Revocation propagation delay bounded at one sync interval (5s)
* `REVOCATION_FAIL_CLOSED=1` rejects when snapshot age > 3×interval + 5s
