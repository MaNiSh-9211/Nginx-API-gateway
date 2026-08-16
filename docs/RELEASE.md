# Release Gate Checklist

**Quick answer:** see [`PRODUCTION_READY.md`](PRODUCTION_READY.md) for the full
automated + human gate.

Run this before tagging a production release. Automates most steps via
`dev/scripts/release-check.ps1`.

---

## 1. Automated validation

```powershell
cd dev
powershell -File scripts/release-check.ps1
```

Linux/macOS: `dev/scripts/release-check.sh` (runs `dev/tests/e2e.sh` smoke when stack is up).

Runs: Rust unit tests (3 crates), compose validate (single-node, multi-region, UAM stack), Helm template lint, and optionally E2E (`dev/test.ps1` — 39 checks).

Helm uses the local CLI when available; otherwise pulls `alpine/helm` via Docker.
See [ADR-0036](decisions/0036-release-gate-automation.md).

Optional (slower, from `dev/`):

```powershell
powershell -File scripts/load-test.ps1 -Smoke    # ~30 s load
powershell -File tests/chaos_test.ps1            # resilience
powershell -File scripts/load-test.ps1           # full 500 VU (~2 min)
powershell -File scripts/test-uam.ps1            # UAM integration (22 checks)
```

---

## 2. Security

- [ ] `JWT_SECRET` rotated from dev default
- [ ] `ADMIN_API_KEY` ≠ `change_me_in_production`
- [ ] TLS certs are real (not image-baked self-signed) — [ADR-0016](decisions/0016-tls-termination.md)
- [ ] Redis on private network; password/ACL if shared — [ADR-0028](decisions/0028-redis-authentication-and-isolation.md)
- [ ] Control plane not publicly reachable — [ADR-0023](decisions/0023-admin-api-hmac-authentication.md)
- [ ] `/metrics` scraped from VPC only

---

## 3. Configuration

- [ ] `GATEWAY_REGION` set per PoP (`EU`/`US`/`AP`)
- [ ] `GATEWAY_REFUSE_INSECURE_SECRETS=1` in production (ADR-0041)
- [ ] Upstreams trust `X-User-Id` only on the private network (ADR-0040)
- [ ] `global_max_concurrency` sized for hardware
- [ ] Config snapshot committed / pushed to control plane

---

## 4. Observability

- [ ] Prometheus scraping gateway + control-plane
- [ ] Alert rules loaded (`platform/monitoring/prometheus/rules/`)
- [ ] Grafana dashboard visible
- [ ] JSON access logs shipping to log platform — [ADR-0026](decisions/0026-structured-json-access-logs.md)

---

## 5. Kubernetes (if applicable)

- [ ] `terminationGracePeriodSeconds` ≥ 45 — [ADR-0031](decisions/0031-graceful-shutdown-zero-downtime.md)
- [ ] Readiness = `/ready`, liveness = `/health` — [ADR-0024](decisions/0024-health-vs-readiness-probes.md)
- [ ] Sidecar healthy before gateway receives traffic
- [ ] Helm values secrets from secret manager, not `values.yaml`

---

## 6. Documentation

- [ ] [CHANGELOG.md](../CHANGELOG.md) updated
- [ ] New behavior has an ADR if it changes architecture
- [ ] [PERFORMANCE.md](PERFORMANCE.md) updated if hot path changed

---

## 7. Tag

```bash
git tag -a v0.6.0 -m "Production release v0.6.0"
git push origin v0.6.0
```

Build and push images with immutable tags matching the release version.

---

## Related

- [PRODUCTION.md](PRODUCTION.md)
- [guides/CLOUD_DEPLOY.md](guides/CLOUD_DEPLOY.md)
- [OPERATIONS.md](OPERATIONS.md)
