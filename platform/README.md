# Platform

Shared infrastructure — **not application services**. Deploy once per cluster
or observability stack.

| Path | Contents |
|------|----------|
| [`monitoring/`](monitoring/) | Prometheus scrape configs, Grafana dashboards, alert rules, OTel |
| [`deploy/`](deploy/) | Helm charts (`api-gateway`, `uam`) and Kubernetes reference manifests |

Helm (production):

```bash
helm install api-gateway platform/deploy/helm/api-gateway/
helm install uam platform/deploy/helm/uam/
```

Compose mounts `platform/monitoring/prometheus` and `platform/monitoring/grafana`
when you run the stack from [`dev/docker-compose.yml`](../dev/docker-compose.yml).

### Scrape targets (dev)

| Job | Service | Endpoint |
|-----|---------|----------|
| `gateway` | gateway-edge | `:8080/metrics` |
| `control-plane` | gateway-control-plane | `:8081/metrics` |
| `config-sidecar` | gateway-sidecar | `:9092` |
| `redis` | redis-exporter | `:9121/metrics` |
| `uam-backend` | uam-backend (UAM overlay) | `:8080/metrics` |
| `uam-frontend-nginx` | nginx-exporter (UAM overlay) | `:9113/metrics` |

Grafana dashboards (auto-provisioned): **API Gateway — Hot Path**, **Platform — Stack Overview**, **UAM — Auth Service**.
