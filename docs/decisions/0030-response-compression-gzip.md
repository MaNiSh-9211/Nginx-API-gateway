# ADR-0030 — Response compression (gzip) at the edge

**Status:** Accepted

## Context

JSON API responses are often repetitive and compress well (3–10× reduction).
Compressing at each upstream microservice duplicates CPU work and makes cache
keys and `Content-Encoding` handling inconsistent. Compressing at the gateway
reduces bandwidth to clients and can improve perceived latency on slow links.

## Decision

Enable **gzip** in `gateway/nginx.conf` for safe, compressible types:

```nginx
gzip on;
gzip_comp_level 2;      # fast — level 6+ costs CPU for marginal gain at the edge
gzip_min_length 1024;   # skip tiny responses (headers dominate)
gzip_proxied any;       # compress proxied upstream responses too
gzip_types application/json text/plain application/javascript;
```

**Why level 2:** At gateway scale, compression runs on every worker for every
eligible response. Level 2 is ~5× faster than level 6 with ~90% of the ratio on
JSON. We optimize for **throughput**, not maximum compression ratio.

**Why not Brotli:** NGINX brotli requires a third-party module not in stock
OpenResty builds. gzip is universal; brotli can be added at an external CDN
(Cloudflare, CloudFront) if needed.

## Alternatives considered

- **Upstream compresses.** Each service picks its own level/types; wastes fleet
  CPU and breaks `proxy_cache` semantics if encoding varies.
- **No compression.** Wastes bandwidth; rejected for JSON-heavy APIs.
- **gzip level 6 (default).** Better ratio but measurably higher CPU at 2k+ RPS;
  rejected for the data plane hot path ([PERFORMANCE.md](../PERFORMANCE.md)).

## Consequences

- Lower egress bandwidth and faster downloads for large JSON payloads.
- Small responses (&lt; 1 KB) are not compressed — overhead not worth it.
- `Vary: Accept-Encoding` is handled by NGINX automatically for gzip.

## Related

- [ADR-0017 — Multi-layer caching](0017-multi-layer-caching.md)
- [docs/PERFORMANCE.md](../PERFORMANCE.md)
