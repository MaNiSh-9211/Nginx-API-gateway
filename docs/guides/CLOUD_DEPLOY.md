# Cloud Deployment Guide

How to run this gateway on major cloud platforms. For the generic checklist see
[PRODUCTION.md](../PRODUCTION.md). For Kubernetes manifests see
[`platform/deploy/helm/api-gateway/`](../../platform/deploy/helm/api-gateway/).

---

## Architecture pattern (all clouds)

```
Internet → [Cloud LB / CDN] → Gateway pods (OpenResty + Rust + sidecar)
                                    ↓
                              Control plane (private)
                                    ↓
                              Redis (private) + Upstreams
```

Every cloud deployment uses the same **sidecar config pattern** (ADR-0012) and
**Helm chart** — only networking, certs, and Redis endpoints change.

---

## AWS

### Recommended topology

| Component | AWS service |
|-----------|-------------|
| Gateway | **EKS** + Helm chart, or ECS Fargate |
| Load balancer | **ALB** (L7) or **NLB** (L4 + TLS at gateway) |
| TLS certs | **ACM** — terminate at ALB *or* mount via cert-manager |
| Redis | **ElastiCache Redis** (cluster mode optional) |
| Secrets | **Secrets Manager** → EKS External Secrets Operator |
| Config | Control plane on private subnet; no public IP |
| Observability | **AMP** (Managed Prometheus) scrapes `/metrics` via VPC |

### Key settings

```yaml
# Helm values (EKS)
gateway:
  region: EU   # or US / AP per PoP
  service:
    type: LoadBalancer
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: "nlb"

redis:
  host: master.xxx.cache.amazonaws.com
  port: "6379"
  password: "<from-secret>"
  tls: true   # REDIS_TLS=1 → rediss://
```

### Real IP behind ALB

Add ALB subnet CIDRs to `set_real_ip_from` in `nginx.conf`, or use
`proxy_protocol` on NLB ([ADR-0027](../decisions/0027-trusted-proxy-real-ip-and-slowloris.md)).

### Multi-region

One EKS cluster (or ECS service) per region with `GATEWAY_REGION=EU|US|AP`.
Front with **Route 53 latency routing** or **Global Accelerator**
([ADR-0018](../decisions/0018-multi-region-anycast.md)).

---

## Google Cloud (GKE)

| Component | GCP service |
|-----------|-------------|
| Gateway | **GKE** + Helm |
| Load balancer | **GKE Ingress** or **Gateway API** |
| TLS | **Google-managed certs** on Ingress |
| Redis | **Memorystore for Redis** |
| Secrets | **Secret Manager** + CSI driver |

```yaml
gateway:
  service:
    type: LoadBalancer
redis:
  host: 10.x.x.x   # Memorystore private IP
  password: ""
```

GKE **Network Policies**: gateway namespace can reach Redis + upstreams only.

---

## Azure (AKS)

| Component | Azure service |
|-----------|-----------------|
| Gateway | **AKS** + Helm |
| Load balancer | **Azure Application Gateway** or AKS `LoadBalancer` |
| TLS | **Key Vault** certificates |
| Redis | **Azure Cache for Redis** |
| Secrets | **Key Vault** Provider for Secrets Store CSI |

```yaml
redis:
  host: mycache.redis.cache.windows.net
  port: "6380"      # Azure TLS port
  password: "<key>"
  tls: true
```

Set `REDIS_TLS=1` for Azure Cache TLS endpoint ([ADR-0028](../decisions/0028-redis-authentication-and-isolation.md)).

---

## Why not managed API Gateway (AWS API GW / Apigee)?

See [COMPARISON.md](../COMPARISON.md). Summary: managed gateways trade latency
and control for fully hosted ops. This project targets **sub-ms Rust hot path**
and **self-hosted** data residency — run on cloud VMs/K8s, not as a SaaS API
Gateway product.

---

## Pre-flight checklist (any cloud)

- [ ] `JWT_SECRET` and `ADMIN_API_KEY` in secret manager
- [ ] `GATEWAY_REGION` matches PoP
- [ ] Redis on private network; `REDIS_TLS=1` if cross-VPC
- [ ] Control plane not public; HMAC on config pushes (ADR-0023)
- [ ] Prometheus scrapes `/metrics` from VPC only
- [ ] Real certs mounted; not self-signed (ADR-0016)
- [ ] `terminationGracePeriodSeconds` ≥ 45 (ADR-0031)
- [ ] Run `dev/test.ps1` or `dev/tests/e2e.sh` against staging before cutover

---

## Related

- [PRODUCTION.md](../PRODUCTION.md)
- [guides/MTLS.md](MTLS.md)
- [platform/deploy/helm/api-gateway/README.md](../../platform/deploy/helm/api-gateway/README.md)
