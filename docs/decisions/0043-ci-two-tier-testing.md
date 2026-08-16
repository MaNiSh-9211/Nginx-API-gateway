# ADR-0043 — CI two-tier testing (fast unit vs Docker E2E)

**Status:** Accepted

## Context

ADR-0020 defines unit, E2E, chaos, and load layers. GitHub Actions has finite
minutes and no PowerShell-first assumption on `ubuntu-latest`. We need CI that:

- Fails fast on logic regressions without Docker.
- Still validates the **real** stack (FFI, NGINX, sidecar, Redis) on every PR.
- Does not duplicate the full 33-case `test.ps1` on every push (slow, Windows-oriented).

## Decision

**Tier 1 — every PR/push (no Docker for Rust):**

- `cargo test --release` for `services/gateway/edge/rust-ext`, `control-plane`, `config-sidecar`
  (matrix job).
- `docker compose config` + Helm `template` lint.

**Tier 2 — Docker E2E job:**

- `docker compose up -d --build --wait`
- `tests/e2e.sh` — **12 smoke assertions** covering health, auth, WAF,
  identity headers, config secret stripping, metrics, and `POST /revoke`.

**Tier 3 — operator / release gate (local, nightly, or pre-tag):**

- `test.ps1` — **33 cases** (config push/rollback, full WAF matrix, residency
  routing, revocation by token hash).
- `scripts/release-check.ps1` / `.sh` — unit + compose + Helm + full E2E.
- `.github/workflows/nightly.yml` — scheduled `e2e.sh` + unit tests on `main`.
- `tests/chaos_test.ps1`, `scripts/load-test.ps1` — optional, documented in
  [RELEASE.md](../RELEASE.md).

## Alternatives considered

- **Full `test.ps1` in GHA.** Requires PowerShell + longer runtime; `e2e.sh`
  covers the highest-risk integration paths in bash/python3 already on runners.
- **Only unit tests in CI.** Misses NGINX config and FFI wiring — rejected.
- **k6 on every PR.** Flaky on shared runners; kept for release week / manual
  ([ADR-0029](0029-chaos-and-resilience-testing.md)).

## Consequences

- PR CI stays under ~10 minutes with meaningful Docker coverage.
- Windows developers use `test.ps1`; Linux CI uses `e2e.sh` — same JWT minting
  contract, different shell.
- Release tagging must still run `release-check.ps1` (or `.sh` + `test.ps1` on
  Windows) before `v*` tags.

## Related

- [ADR-0020 — Testing strategy](0020-testing-strategy.md)
- [ADR-0036 — Release gate](0036-release-gate-automation.md)
- [`../../tests/e2e.sh`](../../tests/e2e.sh)
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
