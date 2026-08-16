# ADR-0042 — Optional eBPF/XDP L4 DDoS filter (out-of-band)

**Status:** Accepted (optional operator component)

## Context

ADR-0006 and ADR-0010 protect the gateway at **L7** (WAF, backpressure). Under a
volumetric **L4** attack (SYN flood, connection exhaustion), packets still reach
the kernel TCP stack and NGINX workers before they can be dropped. At planet
scale, burning CPU on packets that will never become valid HTTP requests is
wasteful.

## Decision

Ship an **optional**, **not-in-Docker** eBPF/XDP program in `platform/monitoring/ebpf/`:

- Runs at the NIC driver (`XDP_DRV`) — drops malicious packets **before** TCP/NGINX.
- SYN-rate and connection-rate limits per source IP (BPF LRU maps).
- CDN / health-checker allowlist bypass.
- Built and loaded by operators (`make`, `ip link set dev … xdp obj …`).

This is **defense in depth**, not a replacement for L7 WAF or cloud DDoS
(Cloudflare, AWS Shield). The gateway hot path does **not** depend on eBPF.

## Alternatives considered

- **Cloud-only DDoS (CF, Shield).** Recommended primary for most fleets; eBPF is
  for self-hosted bare metal or hybrid where you own the NIC.
- **iptables/nftables rate limit.** Works but runs later in the stack; XDP is
  earlier and cheaper per packet.
- **Integrate eBPF into Rust hot path.** Wrong layer; kernel hook belongs in the
  kernel, not `process_request`.
- **Ship in default Docker image.** Requires privileged caps, kernel headers, and
  NIC-specific load steps — poor fit for generic K8s; kept as infra optional.

## Consequences

- Operators running bare-metal PoPs can drop SYN floods before NGINX.
- Not built or tested in CI; document-only + reference C source.
- Cloud/K8s users rely on ADR-0018 anycast + provider DDoS instead.

## Related

- [ADR-0006 — WAF](0006-waf-aho-corasick.md)
- [ADR-0010 — Backpressure](0010-backpressure-admission-control.md)
- [ADR-0018 — Multi-region / anycast](0018-multi-region-anycast.md)
- [`../../platform/monitoring/ebpf/xdp_ddos_filter.c`](../../platform/monitoring/ebpf/xdp_ddos_filter.c)
