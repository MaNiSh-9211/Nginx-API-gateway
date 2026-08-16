# ADR-0012 — Config distribution: per-node sidecar + file watch

**Status:** Accepted

## Context

Each gateway runs one worker per core. Every worker needs the latest config
(ADR-0011). The naive approach — each worker polls the control plane over HTTP —
multiplies load by the worker count and creates a thundering herd at fleet scale
(N nodes × W workers requests every interval).

## Decision

Split fetching from consuming:

- A **single `config-sidecar` per node** polls `GET /config` (default every 5 s)
  and writes the snapshot **atomically** (temp file + rename) to a path shared
  with the gateway (`GATEWAY_CONFIG_PATH`, default under the temp dir; in compose
  a shared volume at `/etc/gateway/config.json`).
- Each gateway **worker watches that file** by `stat`-ing it once per second
  (served from the OS dentry cache — effectively free) and, on change,
  deserializes and `ArcSwap`-stores the new config and rebuilds the router.

So the control plane sees **one poll per node**, not per worker, and workers
never make network calls for config.

## Alternatives considered

- **Per-worker HTTP polling (with jitter).** Jitter spreads the herd but still
  means N×W requests and couples every worker to control-plane availability. A
  vestigial `jitter_millis` helper from this design was removed.
- **Server push / streaming (SSE, gRPC xDS, websockets).** Lower update latency
  and elegant at scale, but adds a streaming protocol, connection management, and
  reconnection logic. The 5 s sidecar poll + 1 s file stat is simple, robust,
  and easily fast enough for human-paced config changes. xDS-style streaming is
  a sensible future upgrade if sub-second propagation is ever required.
- **Bake config into the image.** Immutable and simple but loses runtime updates
  and rollback (ADR-0011). Rejected.

## Consequences

- Control-plane load scales with **node count**, not worker count; workers are
  decoupled from control-plane uptime (they keep serving the last file).
- Atomic writes mean a worker never reads a half-written config.
- Cost: propagation latency is up to ~6 s (5 s poll + 1 s stat) — fine for config,
  not for anything needing instant fan-out. The sidecar and gateway must agree on
  `GATEWAY_CONFIG_PATH` (enforced in compose).
