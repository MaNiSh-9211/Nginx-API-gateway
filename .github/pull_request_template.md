## Summary

<!-- What changed and why (1–3 sentences). -->

## ADR

- [ ] No architectural trade-off changed, OR
- [ ] New/updated ADR in `docs/decisions/` (required for stack, security, deploy changes)

## Testing

- [ ] `scripts/release-check.ps1` passes (or `release-check.sh` + `test.ps1` on Linux)
- [ ] Unit tests pass for touched crates

## Docs

- [ ] `CHANGELOG.md` updated if user-visible behavior changed
- [ ] `docs/README.md` ADR index updated if new ADR added

## Security

- [ ] No secrets, `.env`, or keys committed
- [ ] No `jwt_secret` in config API responses
