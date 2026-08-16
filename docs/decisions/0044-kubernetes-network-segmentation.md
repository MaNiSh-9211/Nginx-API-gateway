# ADR-0044 — Kubernetes network segmentation (reference NetworkPolicies)

**Status:** Accepted

## Context

ADR-0023 requires the control plane and admin APIs (`POST /config`, `POST /revoke`)
to stay off the public internet. ADR-0015 restricts `/metrics` to RFC1918 in
NGINX config, but **pod-to-pod** traffic inside a cluster is open by default —
any compromised workload could reach `control-plane:8081` or Redis.

Kubernetes **NetworkPolicy** (with a CNI that enforces it: Calico, Cilium, AWS
VPC CNI with policy, etc.) is the standard way to enforce least-privilege
east-west traffic.

## Decision

1. **Do not enable NetworkPolicy in the default Helm chart** — policies are
   CNI- and topology-specific (ingress controller namespace, service mesh, managed
   Redis hostname). Wrong defaults break installs silently.

2. **Ship reference policies** in `platform/deploy/kubernetes/network-policy.yaml` that
   operators can adapt:
   - **Control plane:** ingress only from `app=gateway` and `app=config-sidecar`
     on port 8081.
   - **Redis:** ingress only from `app=gateway` and `app=control-plane` on 6379.
   - **Gateway:** ingress on 8080/8443 from ingress-controller namespace
     (label selector placeholder).

3. Document in [PRODUCTION.md](../PRODUCTION.md) and [SLO.md](../SLO.md) that
   network segmentation is required for production multi-tenant clusters.

## Alternatives considered

- **NetworkPolicy in Helm with `networkPolicy.enabled`.** Good for mature ops
  teams; we provide the reference YAML first, Helm toggle as a follow-up if
  clusters converge on Calico/Cilium.
- **Service mesh (mTLS everywhere).** Strongest; heavy operational cost — see
  [MTLS.md](../guides/MTLS.md) for incremental adoption.
- **Security groups only (cloud LB).** Protects north-south, not east-west pod
  traffic; insufficient alone.

## Consequences

- Production K8s deploys must apply adapted NetworkPolicies after `kubectl apply`.
- Clusters without a enforcing CNI ignore the YAML harmlessly (no-op) — operators
  must verify their CNI supports policy.
- Complements NGINX `/metrics` IP allowlist and private control-plane routing.

## Related

- [ADR-0023 — Admin HMAC](0023-admin-api-hmac-authentication.md)
- [ADR-0028 — Redis isolation](0028-redis-authentication-and-isolation.md)
- [`../../platform/deploy/kubernetes/network-policy.yaml`](../../platform/deploy/kubernetes/network-policy.yaml)
- [SECURITY.md](../SECURITY.md)
