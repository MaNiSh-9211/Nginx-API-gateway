# ADR-0020 — Testing strategy

**Status:** Accepted (updated for v0.6.x)

## Context

A gateway's bugs are expensive (they affect all traffic) and its behavior spans
pure logic (auth/WAF/LB), process integration (NGINX↔Rust FFI), distributed
behavior (config distribution), and performance/resilience. No single test type
covers all of that, and the FFI + multi-process nature makes some parts hard to
unit-test in isolation.

## Decision

A layered test strategy, each layer targeting what it is best at:

- **Rust unit tests** (`cargo test --release`):
  - `services/gateway/edge/rust-ext` — **45 tests**: JWT, WAF, LB, cache, backpressure, circuit breaker, …
  - `control-plane` — **16 tests**: HMAC, config store, revocation keys
  - `config-sidecar` — **3 tests**: atomic write
  - Run in CI **without Docker** (fast feedback).
- **CI E2E smoke (`tests/e2e.sh`)** — **14 tests**: health, auth, WAF,
  identity headers, config secret stripping, metrics, `POST /revoke`. Runs in
  GHA after `docker compose up` ([ADR-0043](0043-ci-two-tier-testing.md)).
- **Full E2E (`test.ps1`)** — **34 tests**: everything in `e2e.sh` plus
  residency routing matrix, full WAF cases, config push/rollback, revocation by
  token hash, Prometheus on control plane. **Mints real HS256 JWTs.** Works with
  both the default `echo-backend` and the opt-in `backend-test-service`
  ([ADR-0047](0047-testing-services.md)).
- **Interactive test console** (`docker-compose.testing.yml`) — SPA at
  `:8090` for manual QA; not part of the release gate.
- **Release gate (`scripts/release-check.ps1` / `.sh`)** — unit + compose +
  Helm + full `test.ps1` ([ADR-0036](0036-release-gate-automation.md)).
- **Chaos (`tests/chaos_test.ps1`)** — Redis partition, upstream crash, gateway
  restart ([ADR-0029](0029-chaos-and-resilience-testing.md)).
- **Load (`scripts/load-test.ps1`, k6)** — throughput and p99 on real hardware
  ([PERFORMANCE.md](../PERFORMANCE.md)).

## Alternatives considered

- **Only end-to-end tests.** High confidence but slow, flaky, and poor at
  pinpointing security regressions; the cheap, fast unit layer must own the
  crypto/WAF edge cases.
- **Only unit tests.** Misses the FFI glue, NGINX config correctness, config
  distribution, and real network behavior — exactly where integration bugs live.
- **Mocking NGINX in Rust tests.** High effort, low fidelity; better to run real
  OpenResty in the E2E layer.
- **Full `test.ps1` on every CI push.** Slow and PowerShell-centric; split tiers
  per [ADR-0043](0043-ci-two-tier-testing.md).

## Consequences

- Fast feedback on logic (unit) plus realistic coverage of integration,
  resilience, and performance (E2E/chaos/load).
- Latency numbers are **design targets** validated by load tests on your hardware.
- Release tagging requires the full gate, not CI smoke alone.

## Related

- [ADR-0047 — Testing services](0047-testing-services.md)
- [ADR-0043 — CI two-tier testing](0043-ci-two-tier-testing.md)
- [ADR-0036 — Release gate](0036-release-gate-automation.md)
- [RELEASE.md](../RELEASE.md)
