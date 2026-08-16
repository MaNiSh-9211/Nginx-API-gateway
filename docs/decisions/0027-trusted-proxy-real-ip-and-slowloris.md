# ADR-0027 — Trusted proxy real IP and slow-client hardening

**Status:** Accepted

## Context

The gateway sits behind cloud load balancers (ALB, NLB, Cloudflare, Kubernetes
Ingress). `$remote_addr` would otherwise show the LB's IP, breaking:

- Per-IP WAF rate limits (ADR-0006)
- Geo / abuse analysis in access logs
- Audit trails

Without timeouts, slow clients can hold worker connections (Slowloris-class
attacks) and exhaust the connection table.

## Decision

### Trusted proxy real IP

In `gateway/nginx.conf`:

```nginx
set_real_ip_from  10.0.0.0/8;
set_real_ip_from  172.16.0.0/12;
set_real_ip_from  192.168.0.0/16;
real_ip_header    X-Forwarded-For;
real_ip_recursive on;
```

Rust receives `ngx.var.remote_addr` (already rewritten) as `client_ip` in
`process_request` for WAF per-IP limits.

**Production:** extend `set_real_ip_from` with your LB subnet CIDRs or use
`geo`/`map` — never trust `X-Forwarded-For` from the public internet without
a trusted hop list.

### Slow-client and connection limits

| Setting | Value | Why |
|---------|-------|-----|
| `keepalive_timeout` | 15s | Release idle client connections |
| `keepalive_requests` | 10000 | Reuse connections for burst APIs |
| `client_header_timeout` | 5s | Slow header read → close |
| `client_body_timeout` | 5s | Slow body read → close |
| `send_timeout` | 10s | Slow client read of response → close |
| `reset_timedout_connection` | on | Free kernel state immediately |
| `worker_connections` | 65535 | Match high `somaxconn` (ADR-0019) |
| `listen ... backlog=65535` | both servers | Absorb SYN bursts |

## Alternatives considered

- **Trust all `X-Forwarded-For`.** Trivially spoofable by clients connecting
  directly; only safe behind a known LB.
- **Per-IP limits using raw TCP address only.** Wrong client IP behind LB.
- **No timeouts (NGINX defaults).** Vulnerable to slowloris on edge-facing
  deployments.

## Consequences

- WAF and logs see the end-user IP when the deployment topology matches the
  trusted-CIDR list.
- Misconfigured `set_real_ip_from` can spoof client IPs — document per cloud.
- Aggressive timeouts may cut very slow mobile clients; tune per product SLA.

## Related

- [ADR-0006 — WAF](0006-waf-aho-corasick.md)
- [ADR-0019 — Kernel tuning](0019-deployment-and-kernel-tuning.md)
- [docs/SECURITY.md](../SECURITY.md)
