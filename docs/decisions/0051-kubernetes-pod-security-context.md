# ADR-0051 — Kubernetes pod security context (restricted baseline)

**Status:** Accepted

## Context

Gateway pods run in production on Kubernetes. Without explicit
`securityContext`, containers inherit permissive defaults:

- `allowPrivilegeEscalation: true` (setuid binaries can gain more privilege)
- All Linux capabilities retained
- Writable root filesystem
- Service account token auto-mounted (unnecessary attack surface if a container
  is compromised)

CIS Kubernetes Benchmark and the Pod Security "restricted" profile recommend
locking this down. We must balance hardening with what each workload actually
needs.

## Decision

Apply **layered** security contexts in the Helm chart and reference K8s manifests:

| Workload | Rationale |
|----------|-----------|
| **Pod** | `automountServiceAccountToken: false` (no K8s API access needed), `seccompProfile: RuntimeDefault`, `fsGroup: 1000` for shared config volume |
| **Gateway (OpenResty)** | `allowPrivilegeEscalation: false` only. Master process still runs as root to `setuid`/`setgid` worker processes and writes PID/cache under `/tmp` and `/var/run` — dropping all caps or forcing `readOnlyRootFilesystem` breaks nginx worker startup |
| **Config sidecar (Rust)** | `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`. Writes only to the shared `/etc/gateway` volume |
| **Control plane (Rust)** | Pod-level `runAsNonRoot` + `runAsUser: 1000` (matches Dockerfile `useradd -u 1000`), plus full sidecar lockdown above. Stateless in-memory store; `conf.d` mounted read-only |

## Alternatives considered

- **Full "restricted" profile on every container including gateway.** Rejected —
  OpenResty/nginx requires root master + `CAP_SETUID`/`CAP_SETGID` for the
  standard privilege-drop model. Forcing `runAsNonRoot` on the gateway container
  would require a custom entrypoint that pre-creates cache/pid paths with correct
  ownership — higher operational cost for marginal gain when the gateway is
  already network-isolated.
- **No hardening (status quo).** Rejected — fails CIS/restricted baseline and
  leaves obvious escalation paths on the Rust sidecars that don't need them.
- **AppArmor/SELinux profiles per pod.** Strongest; deferred to platform teams
  (GKE Autopilot, EKS hardening) because profiles are cluster-specific.

## Consequences

- Rust sidecars meet the restricted profile; gateway meets a documented
  exception with `allowPrivilegeEscalation: false` as the minimum viable control.
- Control-plane Docker image pins `gateway` user to **uid 1000** so K8s
  `runAsUser` matches the image (verifiable, not an arbitrary system uid).
- Operators on hardened clusters (PSA "restricted") may still need a namespace
  exemption for the gateway container only — document in `docs/PRODUCTION.md`.

## Related

- [ADR-0013 — Secrets via environment](0013-secrets-via-environment-not-config-wire.md)
- [ADR-0044 — Network segmentation](0044-kubernetes-network-segmentation.md)
- [`platform/deploy/helm/api-gateway/templates/gateway.yaml`](../../platform/deploy/helm/api-gateway/templates/gateway.yaml)
