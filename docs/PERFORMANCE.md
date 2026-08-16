# Performance & Load Testing

How we measure gateway throughput, what the numbers mean, and how to reproduce
them on your hardware.

---

## Latency budget (Rust hot path only)

These are **design targets** for `process_request` — excluding TLS, network I/O,
and upstream proxy time. See [REQUEST_LIFECYCLE.md](REQUEST_LIFECYCLE.md).

| Stage | Target | ADR |
|-------|--------|-----|
| Backpressure | ~5 ns | [0010](decisions/0010-backpressure-admission-control.md) |
| WAF (Aho-Corasick) | ~200 ns | [0006](decisions/0006-waf-aho-corasick.md) |
| JWT (cache hit) | ~50 ns | [0005](decisions/0005-local-jwt-validation.md) |
| JWT (cache miss) | ~2–5 µs | [0005](decisions/0005-local-jwt-validation.md) |
| Routing | ~10 ns | [0014](decisions/0014-data-residency-identity-routing.md) |
| Rate limit | ~15 ns | [0007](decisions/0007-rate-limiting-token-bucket-shared-memory.md) |
| Load balance | ~20 ns | [0009](decisions/0009-load-balancing-consistent-hash-ema.md) |
| **Total Rust** | **~300–600 ns** | [0003](decisions/0003-lock-free-hot-path.md) |

Prometheus histogram `gateway_latency_us` measures **end-to-end gateway time**
(access → log), including proxy to upstream. P99 &lt; 1 ms is the alert threshold
(`platform/monitoring/prometheus/rules/gateway-alerts.yml`).

---

## Load test methodology

We use **[k6](https://k6.io/)** via Docker — no local install required:

```powershell
# Smoke (~30 s, 50 VUs) — CI / dev
./scripts/load-test.ps1 -Smoke

# Full (~2 min, 500 VUs) — pre-release
./scripts/load-test.ps1
```

### What we measure

| Profile | VUs | Duration | Path | Why |
|---------|-----|----------|------|-----|
| **Smoke** | 50 | 30 s | `GET /api/v1/orders` + JWT | Fast regression gate |
| **Full** | 500 | 2 min | Same | Saturate single-node reference stack |

Both profiles mint a **real HS256 JWT** (same claims as `test.ps1`) so the full
hot path runs: WAF → auth → residency routing → rate limit → LB → proxy.

### What we deliberately do *not* load-test

**Anonymous `/public/*` at high RPS from one IP.** The WAF applies a
**per-IP limit** (default 100 RPS, `WAF_IP_RATE_LIMIT_RPS`) to unauthenticated
traffic ([ADR-0006](decisions/0006-waf-aho-corasick.md)). A k6 run from a
single Docker IP would trip 429s — that is correct security behavior, not a
throughput regression. Public routes are checked once in k6 `setup()`.

To test IP rate limiting explicitly, use `tests/waf_rate_limit.js` (low VU).

---

## Reference results (single-node Docker, Windows host)

Environment: Docker Desktop, `GATEWAY_REGION=GLOBAL`, echo-server upstream,
JWT LRU warm after ~30 s ramp.

### Smoke (50 VUs, 30 s) — authenticated path

| Metric | Result | Threshold |
|--------|--------|-----------|
| Throughput | **~2,360 req/s** | — |
| `http_req_duration` p95 | **~24 ms** | — |
| `http_req_duration` p99 | **~30 ms** (prior run) | &lt; 200 ms ✓ |
| `http_req_failed` | **0.00%** | &lt; 1% ✓ |
| Iterations (30 s) | ~70,900 | — |

*Includes echo-server round-trip + Docker NAT. Rust hot path is sub-ms; dominant
cost is proxy I/O and loopback networking.*

### Full (500 VUs, 2 min) — authenticated path

Measured on Docker Desktop / Windows host, echo-server upstream, JWT LRU warm.

| Metric | Result | Threshold |
|--------|--------|-----------|
| Throughput | **~2,400 req/s** | — |
| `http_req_duration` p50 | **~182 ms** | — |
| `http_req_duration` p95 | **~214 ms** | — |
| `http_req_duration` p99 | **~231 ms** | &lt; 300 ms ✓ |
| `http_req_failed` | **0.00%** | &lt; 1% ✓ |
| Iterations (2 min) | ~288,000 | — |

Under saturation, latency is dominated by **proxy I/O + upstream + Docker NAT**,
not the Rust hot path. On bare-metal or multi-pod K8s without Desktop overhead,
expect materially lower p99. Watch `gateway_in_flight / gateway_max_concurrency`
in Grafana during full load.

---

## Chaos / resilience

```powershell
./tests/chaos_test.ps1
```

Validates:

1. **Redis partition** — gateway stays up (revocation fail-open, ADR-0022)
2. **Upstream crash** — circuit breaker trips; metrics show `gateway_circuit_breaker_state`
3. **Gateway restart** — `/health` recovers within `start_period`

→ [ADR-0029](decisions/0029-chaos-and-resilience-testing.md)

---

## Tuning knobs

| Variable | Default | Effect |
|----------|---------|--------|
| `global_max_concurrency` | 10,000 | Backpressure ceiling (config JSON) |
| `WAF_IP_RATE_LIMIT_RPS` | 100 | Anonymous per-IP WAF limit |
| `rate_limit_max` | per-service | Authenticated per-user RPS |
| `worker_processes` | auto | NGINX workers |
| `worker_connections` | 65,535 | Connections per worker |

Kernel / ulimit: `platform/monitoring/sysctl/`, `platform/monitoring/limits/` — [ADR-0019](decisions/0019-deployment-and-kernel-tuning.md).

---

## Grafana

Dashboard **API Gateway — Hot Path** (`platform/monitoring/grafana/.../services/gateway/edge-hot-path.json`)
shows requests/s, latency histogram, in-flight, WAF blocks, cache, circuit breaker.

Scrape: `http://gateway:8080/metrics` (internal only).
