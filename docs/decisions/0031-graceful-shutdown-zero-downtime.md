# ADR-0031 — Graceful shutdown and zero-downtime deploys

**Status:** Accepted

## Context

Orchestrators (Kubernetes, ECS, Nomad) send **SIGTERM** before removing a pod
from the load balancer. If the gateway exits immediately:

- In-flight requests are cut mid-proxy → client 502s
- Backpressure slots may leak until timeout
- Rust background threads die without flushing telemetry

We need a drain period that matches K8s `terminationGracePeriodSeconds`.

## Decision

### NGINX worker drain

```nginx
worker_shutdown_timeout 30s;
```

On SIGTERM, NGINX stops accepting new connections and waits up to 30 s for
active requests to complete before exiting workers.

### Probe-driven traffic removal (Kubernetes)

Rolling deploy sequence:

1. `preStop` hook optional sleep (0–5 s) — allow EndpointSlice propagation
2. Readiness probe fails → pod removed from Service endpoints
3. `worker_shutdown_timeout` drains in-flight work
4. `terminationGracePeriodSeconds` ≥ 35 s (30 s drain + buffer)

```yaml
readinessProbe:
  httpGet: { path: /ready, port: 8080 }
livenessProbe:
  httpGet: { path: /health, port: 8080 }
terminationGracePeriodSeconds: 45
```

### Backpressure slot lifecycle

Slots are acquired in `process_request` and released in Lua `log()` via
`release_slot()`. A drained request completes the log phase → slot released.
Early-rejected requests release inside Rust. No special SIGTERM handler needed
because NGINX waits for request completion.

### Config during rollout

New pods start with sidecar-fetched config; old pods keep serving until drained.
No shared in-memory state between pods (rate limits use per-node mmap — ADR-0004).

## Alternatives considered

- **Immediate SIGKILL after preStop.** Faster deploys but 502s during drain;
  rejected.
- **Connection pinning at LB forever.** Stale pods never drain; rejected.
- **Shared backpressure across pods.** Would need Redis/etcd; rejected
  ([ADR-0010](0010-backpressure-admission-control.md) — per-node admission is
  intentional).

## Consequences

- Rolling deploys complete without cutting active requests (when grace period is
  sized correctly).
- Per-node rate limits reset on new pods — acceptable; limits are per-node by
  design.
- Operators must set `terminationGracePeriodSeconds` ≥ `worker_shutdown_timeout`.

## Related

- [ADR-0024 — Health vs readiness](0024-health-vs-readiness-probes.md)
- [platform/deploy/helm/api-gateway/templates/gateway.yaml](../../platform/deploy/helm/api-gateway/templates/gateway.yaml)
- [docs/PRODUCTION.md](../PRODUCTION.md)
