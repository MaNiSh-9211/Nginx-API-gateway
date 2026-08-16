# Production Readiness — Is This Gateway Ready?

Use this page as the **single gate** before exposing the gateway to real users.
Every item links to the ADR or runbook that explains *why*.

---

## Automated gate (must pass)

```powershell
cd dev
powershell -File scripts/release-check.ps1
```

| Check | What it proves |
|-------|----------------|
| Rust unit tests | Auth, WAF, LB, HMAC, revocation keys, circuit breaker, sidecar atomic write |
| Docker Compose valid | Single-node, multi-region, testing, and full UAM stacks parse |
| Helm template lint | K8s chart renders |
| E2E 39/39 (`dev/test.ps1`) | Real JWTs, WAF, residency, config, revoke, identity headers, spoof strip |

**UAM integration (optional, with UAM overlay running):** `dev/scripts/test-uam.ps1` — 22 checks (register, cookies, CSRF, refresh, logout, anti-enumeration).

**Interactive demo:** `cd dev && docker compose -f docker-compose.yml -f docker-compose.testing.yml up`
→ test console at `http://localhost:8090` ([ADR-0047](decisions/0047-testing-services.md)).

Linux/macOS: `dev/scripts/release-check.sh` (includes `dev/tests/e2e.sh` smoke when stack is up).

Optional before tag: `dev/tests/chaos_test.ps1`, `dev/scripts/load-test.ps1`

---

## Security (human checklist)

| # | Item | ADR / doc |
|---|------|-----------|
| 1 | `JWT_SECRET` rotated — not dev default | [0013](decisions/0013-secrets-via-environment-not-config-wire.md) |
| 2 | `ADMIN_API_KEY` rotated — HMAC enforced | [0023](decisions/0023-admin-api-hmac-authentication.md) |
| 3 | `GATEWAY_REFUSE_INSECURE_SECRETS=1` | [0041](decisions/0041-refuse-insecure-secrets-at-startup.md) |
| 4 | `CONTROL_PLANE_REFUSE_INSECURE_SECRETS=1` | [0041](decisions/0041-refuse-insecure-secrets-at-startup.md) |
| 5 | Real TLS certs mounted | [0016](decisions/0016-tls-termination.md) |
| 6 | Control plane + `/metrics` on private network | [0023](decisions/0023-admin-api-hmac-authentication.md), [0044](decisions/0044-kubernetes-network-segmentation.md) |
| 7 | Redis authenticated + network isolated | [0028](decisions/0028-redis-authentication-and-isolation.md) |
| 8 | NetworkPolicies applied (K8s) | [0044](decisions/0044-kubernetes-network-segmentation.md) |

Full threat matrix: [SECURITY.md](SECURITY.md) · Report issues: [../SECURITY.md](../SECURITY.md)

---

## Configuration & topology

| # | Item | ADR |
|---|------|-----|
| 1 | `GATEWAY_REGION` = `EU` / `US` / `AP` per PoP | [0014](decisions/0014-data-residency-identity-routing.md) |
| 2 | Upstreams point to real backends (not echo-server) | [0009](decisions/0009-load-balancing-consistent-hash-ema.md) |
| 3 | `global_max_concurrency` sized for hardware | [0010](decisions/0010-backpressure-admission-control.md) |
| 4 | Control plane has `REDIS_*` for `POST /revoke` | [0039](decisions/0039-control-plane-revoke-api.md) |
| 5 | Helm `refuseInsecureSecrets: true` + real secrets | [0045](decisions/0045-helm-production-safe-defaults.md) |

---

## Observability & SLOs

| # | Item | Doc |
|---|------|-----|
| 1 | Prometheus scraping gateway + control-plane | [0015](decisions/0015-observability-prometheus-pull.md) |
| 2 | Alert rules loaded (`platform/monitoring/prometheus/rules/`) | [SLO.md](SLO.md) |
| 3 | Grafana dashboard provisioned | `platform/monitoring/grafana/` |
| 4 | JSON access logs shipped | [0026](decisions/0026-structured-json-access-logs.md) |

---

## Architecture documentation (52 ADRs)

Every major design choice is recorded with **Context → Decision → Alternatives → Consequences**:

- **Index:** [decisions/README.md](decisions/README.md)
- **Philosophy:** [DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md)
- **Why not Kong/Envoy/AWS?** [COMPARISON.md](COMPARISON.md)

---

## What we deliberately defer

| Item | Status | ADR |
|------|--------|-----|
| L1 Rust response cache | Implemented, not wired | [0037](decisions/0037-l1-cache-deferred-l2-primary.md) |
| Native NGINX module | Experimental only | [0002](decisions/0002-lua-ffi-data-plane-over-native-module.md) |
| eBPF XDP filter | Optional bare-metal | [0042](decisions/0042-optional-ebpf-xdp-ddos-filter.md) |

---

## Verdict

When the automated gate passes **and** the human security/topology checklist is
complete, this gateway is **production-ready** for a self-hosted L7 edge with
documented, defensible trade-offs — not an undocumented pile of features.

Next: [RELEASE.md](RELEASE.md) (tag procedure) · [PRODUCTION.md](PRODUCTION.md) (deploy detail) · [OPERATIONS.md](OPERATIONS.md) (day-2)
