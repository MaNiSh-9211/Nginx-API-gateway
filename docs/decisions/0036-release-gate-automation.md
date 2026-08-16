# ADR-0036 — Release gate automation

**Status:** Accepted

## Context

A production gateway must not ship on manual memory alone. We need a repeatable,
fast pre-tag checklist that catches regressions in the Rust hot path, config
distribution, Docker/Helm artifacts, and end-to-end behavior — without
requiring every operator to remember 30 manual steps.

## Decision

Provide `scripts/release-check.ps1` as the **single local release gate**. It runs,
in order:

1. `cargo test --release` for `services/gateway/edge/rust-ext`, `control-plane`, `config-sidecar`
2. `docker compose config` (single-node + multi-region)
3. Helm `template` lint (local `helm` if on PATH, else `alpine/helm` container)
4. Full E2E suite (`test.ps1`, 33 assertions) unless `-SkipE2E`

CI uses `tests/e2e.sh` (12 smoke tests) — see [ADR-0043](decisions/0043-ci-two-tier-testing.md).

CI (`.github/workflows/ci.yml`) mirrors the same layers as separate jobs so
failures are parallel and attributable. Slower checks (k6 load, chaos) stay
**documented optional** in [`RELEASE.md`](../RELEASE.md), not in the default
gate — they need a running stack and take minutes.

Human checklist items (secret rotation, real TLS certs, alert rules) remain in
`RELEASE.md` because they cannot be automated in a dev repo.

## Alternatives considered

- **Manual checklist only.** Cheap but error-prone; we rejected this for anything
  tagged `v*`.
- **One giant CI job.** Simpler YAML but slow feedback and opaque failures; split
  jobs give faster parallel signal.
- **k6 in every PR.** Catches perf regressions but is flaky on shared runners and
  needs Docker + warm stack; kept as release-week / nightly optional.
- **Bash-only release script.** Windows-first dev environment here; PowerShell
  gate with Docker fallbacks covers both. `tests/e2e.sh` serves Linux CI.

## Consequences

- Tagging a release is one command locally; CI enforces the same bar on `main`.
- Helm lint works even when `helm` CLI is not installed (Docker fallback).
- Operators still must complete security/observability items in `RELEASE.md`
  before production cutover.

## Related

- [`../RELEASE.md`](../RELEASE.md)
- [ADR-0020](0020-testing-strategy.md)
- [`../../scripts/release-check.ps1`](../../scripts/release-check.ps1)
