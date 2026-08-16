# Contributing

Thank you for improving this gateway. The bar is high: every architectural
change needs a **documented reason**.

---

## Before you code

1. Read [DESIGN_PRINCIPLES.md](docs/DESIGN_PRINCIPLES.md) and relevant [ADRs](docs/decisions/README.md).
2. If your change affects architecture, security, or performance trade-offs,
   **add or update an ADR** before merging.

---

## Architecture Decision Records (ADRs)

Template: [docs/decisions/README.md](docs/decisions/README.md)

Each ADR must include:

- **Context** — what problem and constraints
- **Decision** — what we chose
- **Alternatives considered** — what we rejected and **why**
- **Consequences** — upsides and costs

Number sequentially: `0064-your-topic.md`. Update the index in
`docs/decisions/README.md` and `docs/README.md`.

> **Path note:** Older ADRs may reference legacy paths (`services/gateway/`, `testing/`).
> Current layout uses top-level folders (`gateway-edge/`, `uam-backend/`, `dev/`).

---

## Development workflow

```powershell
cd dev
docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml up -d --build
powershell -File test.ps1                  # Gateway E2E (39 checks)
powershell -File scripts/test-uam.ps1      # UAM integration (22 checks)
powershell -File scripts/release-check.ps1 # Full release gate
```

Rust unit tests:

```bash
cd gateway-edge/rust-ext && cargo test --release
cd gateway-control-plane && cargo test --release
cd gateway-sidecar && cargo test --release
```

---

## Code style

- **Rust hot path:** no locks, no allocations where avoidable ([ADR-0003](docs/decisions/0003-lock-free-hot-path.md)).
- **Match existing patterns** in `gateway-edge/rust-ext/` — read surrounding code first.
- **Minimal diffs** — do not refactor unrelated code in the same PR.

---

## Pull request checklist

- [ ] Tests pass (`dev/scripts/release-check.ps1`)
- [ ] ADR added/updated if trade-off changed
- [ ] [CHANGELOG.md](CHANGELOG.md) entry under `Unreleased` or version section
- [ ] No secrets in commits (`.env` is gitignored)

---

## Questions

See [docs/README.md](docs/README.md) for the full documentation map.
