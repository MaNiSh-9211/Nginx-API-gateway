# Service Level Objectives (SLOs)

Operational targets for the gateway data plane. These align with Prometheus
alert rules in `platform/monitoring/prometheus/rules/gateway-alerts.yml` and the latency
budget in [PERFORMANCE.md](PERFORMANCE.md).

> SLOs are measured **per PoP** (per `GATEWAY_REGION` deployment). Adjust
> thresholds for your hardware and upstream latency.

---

## Availability

| SLO | Target | Measurement | Alert |
|-----|--------|-------------|-------|
| Gateway liveness | **99.95%** monthly | `gateway_up == 1`, K8s `/health` | `GatewayDown` |
| Config readiness | **99.9%** monthly | `gateway_config_ready == 1`, `/ready` | `GatewayConfigNotReady` |
| Successful proxy (non-5xx) | **≥ 99%** | `1 - rate(5xx)/rate(total)` over 30d | `GatewayHighErrorRate` |

**Error budget:** 0.05% downtime ≈ **22 minutes/month** per PoP.

---

## Latency (end-to-end gateway time)

Includes access → proxy → log (not upstream-only). Histogram:
`gateway_latency_us`.

| SLO | Target | Alert |
|-----|--------|-------|
| P50 | **< 500 µs** | `GatewayHighP50Latency` |
| P99 | **< 1 ms** | `GatewayHighP99Latency` |

Rust hot-path overhead alone is ~300–600 ns ([ADR-0003](decisions/0003-lock-free-hot-path.md));
these SLOs include NGINX proxy and echo/upstream RTT in the reference stack.

---

## Security & abuse

| SLO | Target | Alert |
|-----|--------|-------|
| WAF block storm | Investigate if **> 100/s** sustained | `GatewayHighWafBlocks` |
| Rate-limit pressure | Tune quotas if **> 1000× 429/s** | `GatewayHighRateLimitRate` |

---

## Capacity

| SLO | Target | Alert |
|-----|--------|-------|
| In-flight utilization | **< 90%** of `global_max_concurrency` | `GatewayBackpressureHigh` |
| Global circuit breaker | **Closed** during normal ops | `GatewayCircuitOpen` |

---

## Control plane (separate SLO)

| SLO | Target | Notes |
|-----|--------|-------|
| Config poll success | Sidecar healthy | `config-sidecar` healthcheck |
| Config push availability | **99.9%** | Admin API on private network only |

Gateway **continues serving last config** if control plane is down
([ADR-0012](decisions/0012-config-distribution-sidecar-file-watch.md)).

---

## How to validate SLOs

```powershell
```powershell
cd dev
powershell -File scripts/load-test.ps1 -Smoke
powershell -File scripts/load-test.ps1
powershell -File scripts/release-check.ps1
```

Import Grafana dashboard `API Gateway — Hot Path` from `platform/monitoring/grafana/`.

---

## Related

- [OPERATIONS.md](OPERATIONS.md) — incident response
- [RELEASE.md](RELEASE.md) — pre-tag checklist
- [ADR-0015](decisions/0015-observability-prometheus-pull.md) — observability
- [ADR-0044](decisions/0044-kubernetes-network-segmentation.md) — network SLO enablers
