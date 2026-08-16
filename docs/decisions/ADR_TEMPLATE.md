# ADR Template

Copy to `docs/decisions/NNNN-short-title.md` and add to
[`README.md`](README.md) and [`../README.md`](../README.md).

```markdown
# ADR-NNNN — Short title

**Status:** Accepted | Superseded by ADR-XXXX | Experimental

## Context

What problem are we solving? What constraints matter (latency, ops, security)?

## Decision

What we chose. Be specific — name the component and behavior.

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Option A | … |
| Option B | … |

## Consequences

- **Gains:** …
- **Costs / risks:** …

## Related

- [ADR-XXXX](XXXX-related.md)
- Code: `path/to/implementation`
```

## Rules

1. One decision per ADR — split large changes into multiple records.
2. Always list **at least two** credible alternatives and why they lost.
3. Link from code comments only when the decision is non-obvious (`// ADR-NNNN`).
4. Supersede old ADRs instead of deleting them; mark **Status: Superseded**.

See [CONTRIBUTING.md](../../CONTRIBUTING.md).
