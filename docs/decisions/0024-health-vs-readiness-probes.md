# ADR-0024 — Health vs readiness probes

**Status:** Accepted

## Context

Orchestrators (Kubernetes, ECS, Nomad) need to know:

1. **Should this process be restarted?** (liveness)
2. **Should this instance receive traffic?** (readiness)

A gateway can be "alive" (NGINX + Rust workers running) but **not ready** (config
not loaded, would return 404/503 for all routes). Conflating the two causes
either unnecessary restarts or traffic to broken pods during rollout.

## Decision

Two endpoints on the data plane:

| Endpoint | Meaning | HTTP |
|----------|---------|------|
| `/health` | Process up; Rust FFI loaded; **does not** require config | 200 always if worker alive |
| `/ready` | Config snapshot loaded (`version != v0`, routes non-empty) | 200 when ready, **503** otherwise |

Implementation:

- `/health` — `is_ready()` not required; returns JSON with `config_version` for
  debugging
- `/ready` — calls Rust `is_ready()` FFI (`gateway_config_ready` gauge = 1)

Kubernetes mapping:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 8080 }
readinessProbe:
  httpGet: { path: /ready, port: 8080 }
```

**Config sidecar** has a separate healthcheck: `test -s /etc/gateway/config.json`
so the gateway pod does not start routing until the file exists.

## Alternatives considered

- **Single `/health` that checks config.** During initial bootstrap or control
  plane outage, kubelet would kill healthy pods in a restart loop.
- **TCP socket probe on :8080.** Proves the port is open, not that Lua/Rust or
  config loaded.
- **Exec probe curling localhost.** Works but slower and couples probe to shell.

## Consequences

- New pods stay out of the Service endpoints until config is present (correct).
- Liveness does not flap during control plane maintenance — only readiness
  drops if config file is removed/corrupt.
- Operators monitor `gateway_config_ready` in Prometheus for fleet-wide config
  delivery issues.

## Related

- [ADR-0012 — Config sidecar](0012-config-distribution-sidecar-file-watch.md)
- [docs/PRODUCTION.md](../PRODUCTION.md)
