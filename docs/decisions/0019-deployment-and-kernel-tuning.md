# ADR-0019 — Deployment model + kernel/ulimit tuning

**Status:** Accepted

## Context

The software is only as fast as the host lets it be. At high connection counts,
default OS limits (file descriptors, socket backlog, ephemeral ports) and NGINX
worker settings become the bottleneck long before CPU does. We also need a
deployment model that works locally and scales to a fleet.

## Decision

**Deployment:** containerized services orchestrated by Docker Compose as a
faithful single-node reference; the same images run on Kubernetes/Nomad for a
fleet (one `config-sidecar` per gateway pod, ADR-0012). Multi-stage builds
produce small images; the control plane and sidecar run as **non-root**.

**Host & NGINX tuning (shipped in `platform/monitoring/` and the compose files):**

- `worker_processes auto` (one per core), `worker_connections 65535`,
  `worker_rlimit_nofile 1048576`, `epoll`, `multi_accept`, `reuseport`.
- **ulimits**: `nofile` raised to ~1M for the gateway (and set in compose).
- **sysctls**: `net.core.somaxconn=65535`, `tcp_tw_reuse=1`, wide
  `ip_local_port_range` (avoids ephemeral-port exhaustion to upstreams), plus the
  reference `platform/monitoring/sysctl/99-gateway-tuning.conf` and
  `platform/monitoring/limits/gateway-limits.conf`.
- `SO_REUSEPORT` lets the kernel load-balance accepts across workers, avoiding a
  single-accept-lock thundering herd.

**Build:** the Rust extension is compiled with LTO, `opt-level=3`,
`codegen-units=1`, `panic=abort`, and stripped (see `rust-ext/Cargo.toml`).
`panic=abort` is required because unwinding across the FFI boundary is undefined
behavior; the code is written to not panic on the hot path, and a fatal startup
error aborts loudly (surfacing misconfiguration) while NGINX respawns workers.

## Alternatives considered

- **Bare-metal/VM systemd deploy.** Viable and sometimes lower overhead, but
  containers give reproducible images and uniform orchestration across PoPs. The
  sysctl/ulimit guidance applies either way.
- **Default OS/NGINX settings.** Functionally correct but caps throughput far
  below the hardware; explicit tuning is necessary for the stated scale.
- **`panic=unwind` + catch_unwind at the boundary.** Avoids aborting a worker on
  panic, but unwinding across `extern "C"` is UB and the catch adds cost; abort
  is the correct, well-defined choice here.

## Consequences

- The node can actually sustain the connection counts the design targets.
- Reproducible, rootless images that deploy identically everywhere.
- Cost: sysctls/ulimits need host privileges (set in compose; on k8s use a
  privileged init/`securityContext` or node-level tuning). `panic=abort` means a
  bug that does panic restarts the worker rather than returning 500 — acceptable
  given the no-panic discipline and supervisor respawn.
