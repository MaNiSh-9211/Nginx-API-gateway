# eBPF / XDP L4 DDoS filter (optional)

**Not part of the default Docker/K8s deployment.** See
[ADR-0042](../../docs/decisions/0042-optional-ebpf-xdp-ddos-filter.md).

## What it does

- Attaches an XDP program to a physical NIC.
- Drops SYN floods and connection-rate abuse **before** packets reach NGINX.
- Complements L7 WAF (ADR-0006) and cloud DDoS — does not replace them.

## Build & load (Linux, bare metal)

```bash
cd platform/monitoring/ebpf
make NIC=eth0    # produces xdp_ddos_filter.o
sudo make load NIC=eth0
sudo make status # dump blocked IPs / counters
sudo make unload NIC=eth0
```

Requirements: `clang`, `llvm`, `libbpf`, root/CAP_BPF on the host.

## When to use

| Scenario | Recommendation |
|----------|----------------|
| Cloudflare / AWS ALB in front | Provider DDoS is enough; skip eBPF |
| Self-hosted PoP on bare metal | Consider XDP + anycast (ADR-0018) |
| Kubernetes generic nodes | Usually skip — use cloud LB + WAF |

## Related

- [platform/monitoring/anycast/README.md](../anycast/README.md)
- [docs/SECURITY.md](../../docs/SECURITY.md)
