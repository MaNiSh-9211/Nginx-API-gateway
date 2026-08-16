# ADR-0033 — DNS-based dynamic upstream discovery

**Status:** Accepted

## Context

Upstream backends change in production: autoscaling adds/removes pods, deploys
swap versions, regional failover shifts DNS. Static NGINX `upstream {}` blocks
require a **reload** for every change and pin resolved IPs at reload time.

We need backends to be **100% config-driven** (from the control plane JSON) with
**no NGINX reload** when topology changes.

## Decision

**Variable `proxy_pass` + runtime DNS resolver:**

```nginx
resolver 127.0.0.11 valid=5s ipv6=off;   # Docker DNS; use kube-dns in K8s
proxy_pass http://$target_upstream;       # host:port from Rust load balancer
```

Flow:

1. Control plane config lists upstream `address` as `hostname:port` (e.g.
   `api-eu-1:8080`).
2. Rust load balancer writes chosen address to `$target_upstream`.
3. NGINX resolves the hostname **per request** (cached 5 s via `valid=5s`).
4. Adding/removing an upstream in config JSON takes effect on next sidecar poll
   (~5 s) — no reload.

In Docker Compose, network **aliases** on `echo-backend` simulate multiple
logical hostnames on one container for dev.

## Alternatives considered

- **Static `upstream {}` blocks + `nginx -s reload`.** Industry standard but
  reload drops in-flight connections and couples routing to NGINX syntax.
  Rejected for GitOps JSON model.
- **`balancer_by_lua` + `set_current_peer(ip)`.** Enables keepalive pools but
  requires Lua to resolve DNS to IPs and handle TTL — more code, more failure
  modes ([ADR-0009](0009-load-balancing-consistent-hash-ema.md)).
- **Service mesh (Envoy sidecar).** Excellent discovery; we avoid mandatory mesh
  complexity; mesh can sit in front of or behind the gateway.

## Consequences

- Backend topology is data, not NGINX config — matches control plane GitOps.
- Trade-off: variable `proxy_pass` does not use upstream keepalive connection
  pools (documented in ADR-0009). Acceptable until connection churn is measured
  as a bottleneck.
- Operators must ensure DNS TTL / `resolver valid=` align with deploy speed.

## Related

- [ADR-0009 — Load balancing](0009-load-balancing-consistent-hash-ema.md)
- [ADR-0011 — Control plane GitOps](0011-control-plane-gitops.md)
- [gateway/nginx.conf](../../services/gateway/edge/nginx.conf)
