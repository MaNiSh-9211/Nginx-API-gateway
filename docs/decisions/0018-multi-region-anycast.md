# ADR-0018 — Multi-region / anycast edge topology

**Status:** Accepted

## Context

A planet-scale gateway must put compute near users (latency) and survive the loss
of a whole region (availability), while honoring data residency (ADR-0014). We
need a strategy for steering users to the right PoP and for failing over.

## Decision

A **regional PoP** model with an **anycast / GeoDNS** front door:

- The same gateway image runs as independent PoPs, each pinned to a
  `GATEWAY_REGION` (`EU`/`US`/`AP`). `docker-compose.multi-region.yml` simulates
  three PoPs locally; `platform/monitoring/anycast/` holds Cloudflare/Route 53/BGP templates.
- **Anycast / GeoDNS** routes each client to its nearest/home PoP. Because the
  edge already steers by geography/identity, the gateway's residency guard
  (ADR-0014) is a backstop, not the primary router, so legitimate users rarely
  hit a cross-region 403.
- Each PoP is self-sufficient: local shared-memory limits/breakers (ADR-0004),
  local config cache (ADR-0012), local upstreams. Losing a region degrades only
  that region; healthy PoPs are unaffected.
- An optional **eBPF/XDP DDoS filter** (`platform/monitoring/ebpf/`) drops volumetric attacks
  in the kernel before they reach NGINX.

## Alternatives considered

- **Single global region behind a global LB.** Simplest, but high latency for
  distant users, a single failure domain, and no data residency. Rejected for a
  planet-scale target.
- **Active-active with cross-region shared state (global rate limits, global
  cache).** Tempting for exactness, but cross-region coordination on the hot path
  is fatal to latency and couples regions' fates. We keep state **regional** and
  scale horizontally; global concerns are handled asynchronously/out of band.
- **GSLB appliance only (no anycast).** Works, but anycast gives faster failover
  and DDoS absorption at the network layer; we support both via templates.

## Consequences

- Low latency near users, region-level fault isolation, enforceable residency.
- Each region scales and fails independently.
- Cost: more moving parts (multiple PoPs, DNS/anycast config) and *eventual*
  cross-region consistency for anything global. The local-first design (limits,
  cache, breakers per node/region) is what makes this tractable.
