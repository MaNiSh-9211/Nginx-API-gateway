# ADR-0029 — Chaos and resilience testing

**Status:** Accepted

## Context

A gateway that passes happy-path E2E tests can still fail in production when
dependencies disappear: Redis down, upstream crash, pod restart during rollout.
We need automated checks that the system **degrades predictably** rather than
cascading into total outage.

## Decision

**Three scripted chaos scenarios** in `tests/chaos_test.ps1`, runnable against
the Docker reference stack:

| # | Fault injected | Expected behavior | ADR |
|---|----------------|-------------------|-----|
| 1 | `docker compose pause redis` | Gateway `/health` stays 200; revocation lookups fail-open | [0022](0022-redis-revocation-fail-open.md) |
| 2 | `docker compose stop echo-backend` | Traffic to upstream fails; circuit breaker opens; gateway process stays up | [0008](0008-circuit-breaker.md) |
| 3 | `docker compose restart gateway` | `/health` recovers within `start_period`; config reloads via sidecar | [0024](0024-health-vs-readiness-probes.md) |

Load testing uses **k6** ([ADR-0020](0020-testing-strategy.md), [PERFORMANCE.md](../PERFORMANCE.md)):

- **Smoke** (50 VUs, 30 s) — CI regression gate via `./scripts/load-test.ps1 -Smoke`
- **Full** (500 VUs, 2 min) — pre-release saturation test
- Authenticated path only at high RPS; anonymous `/public/*` is not hammered from
  one IP because WAF per-IP limits would dominate (correct security, misleading
  throughput) — [0006](0006-waf-aho-corasick.md)

k6 runs in Docker (`grafana/k6`) so contributors need no local install.

## Alternatives considered

- **Gremlin / Chaos Mesh in CI.** Powerful for K8s fleets; too heavy for the
  reference Docker stack. Documented as production next step.
- **Load-test anonymous routes at 500 VUs.** Trips WAF IP limit (100 RPS default);
  rejected as throughput benchmark — tested separately at low VU.
- **No chaos tests.** Leaves resilience claims unproven.

## Consequences

- `./tests/chaos_test.ps1` is manual (not in default CI) because it mutates
  running containers; run before releases.
- k6 smoke can be added to CI with `scripts/load-test.ps1 -Smoke` when Docker
  is available (see `.github/workflows/ci.yml`).
- Production fleets should extend with pod-kill, network partition, and regional
  failover drills ([ADR-0018](0018-multi-region-anycast.md)).

## Related

- [docs/PERFORMANCE.md](../PERFORMANCE.md)
- [docs/OPERATIONS.md](../OPERATIONS.md) — incident response
- [ADR-0020 — Testing strategy](0020-testing-strategy.md)
