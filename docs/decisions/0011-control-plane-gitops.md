# ADR-0011 — Control plane: GitOps config, ArcSwap, signed pushes

**Status:** Accepted

## Context

Routing, services, upstreams, limits, and key material change over time and must
update **without downtime** and with an audit trail and instant rollback. The
data plane must read the active config with near-zero cost (ADR-0003).

## Decision

A dedicated **Rust/Actix control plane** is the source of truth:

- Boots from versioned JSON in `conf.d/` (a full `initial-snapshot.json` or
  per-service files) — GitOps-friendly, reviewable, diffable.
- Keeps a **versioned history** (default 20) with `POST /config` (push) and
  `POST /config/rollback` (revert), `GET /config/history`.
- **Reads are lock-free** via `ArcSwap` (gateways/sidecars poll `GET /config`);
  **writes use a `Mutex`** because they are rare and human-triggered — the
  right place for a lock (contrast ADR-0003).
- Mutations require an **HMAC-SHA256 `X-Admin-Signature`** over the body, keyed
  by `ADMIN_API_KEY` (constant-time compare). With the default key it logs a
  warning and runs in dev mode (no signature) for easy local use; set a real key
  to enforce.
- Also ingests telemetry (`POST /telemetry`) and exposes `/metrics`.

## Alternatives considered

- **etcd / Consul / ZooKeeper.** Battle-tested distributed config stores, but
  they add a stateful clustered dependency and a heavier operational model than
  this gateway needs. A small Rust service with versioned snapshots + ArcSwap
  covers the requirements with far less to run; etcd/Consul can back it later if
  multi-writer consensus is required.
- **Kubernetes CRDs + operator (xDS-style).** Powerful in k8s-native shops, but
  couples config to k8s and is overkill here; our model runs anywhere.
- **Push config straight into NGINX and reload.** `nginx -s reload` per change
  drops/!reuses connections and is coarse; ArcSwap hot-swap is finer and truly
  zero-downtime, and backend changes need no reload at all (ADR-0009).

## Consequences

- Zero-downtime, versioned, rollback-able config with signed, audited mutations.
- Lock-free fan-out: thousands of nodes can read cheaply (and via the sidecar,
  the control plane sees one poll per node — ADR-0012).
- Cost: it is a single logical writer (fine for human-paced changes). For HA,
  run replicas behind the same `conf.d` (Git) source; strong multi-writer
  consistency would need a real consensus store (deferred).
