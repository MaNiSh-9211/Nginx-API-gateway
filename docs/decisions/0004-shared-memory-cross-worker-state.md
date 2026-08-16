# ADR-0004 — Cross-worker state via shared memory (mmap)

**Status:** Accepted

## Context

Some state must be **consistent across all workers on a node**, not per-worker:

- Total in-flight count is per-process (ADR-0010), but rate-limit buckets,
  per-IP WAF limits, circuit-breaker state, and aggregate metrics need a single
  source of truth that every worker reads and writes.

NGINX uses a multi-process model (workers are forked processes, not threads), so
ordinary `static` atomics are **not** shared between workers — each process gets
its own copy.

## Decision

Place shared counters in a **memory-mapped file** (`memmap2`) under the temp dir,
laid out as `#[repr(C)]` structs / arrays of `AtomicU64`. All workers `mmap` the
same file, so atomic operations target the *same physical memory* and are
coordinated by the CPU's cache-coherency protocol — lock-free across processes.

Files used: `gateway_rate_limit.shm`, `gateway_waf.shm`,
`gateway_circuit_breaker.shm` (or equivalent), `gateway_telemetry.shm`.

## Alternatives considered

- **Redis for every counter.** A network round trip (even ~0.2 ms) on the hot
  path is 1000× the budget and adds a hard dependency on Redis availability for
  basic limiting. Rejected for the hot path; Redis is used only for
  cross-*node* concerns off the hot path (revocation, ADR-0005/0007).
- **NGINX `lua_shared_dict`.** Works and is shared across workers, but access
  goes through a Lua API with its own locking and serialization; our `#[repr(C)]`
  atomics in mmap are faster and keep the logic in Rust.
- **Per-worker atomics + periodic gossip.** Avoids shared memory but makes
  limits approximate and bursty (each worker has its own budget). Shared memory
  gives exact, immediate node-wide counters.

## Consequences

- Node-wide counters update in ~tens of ns with no locks and no network.
- Survives worker restarts (the file persists) and is naturally shared on fork.
- Cost: counters are **per node**, not global across the fleet — intentional.
  Global coordination would reintroduce a network hop; instead each node limits
  locally and the fleet scales horizontally (ADR-0007). The mmap files live on
  local/tmpfs storage and are sized up front (e.g. 1M rate-limit slots).
