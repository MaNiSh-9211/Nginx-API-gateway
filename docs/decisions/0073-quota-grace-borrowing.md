# ADR-0073: Quota Grace Borrowing

## Status: Accepted

## Context
Hard daily quota cutoffs frustrate users who slightly exceed their allowance, while fully unlimited fallback defeats billing.

## Decision
`borrow_percent` in the quota policy allows users to exceed their daily limit by up to this percentage before being rejected. Borrowed usage is separately metered (`gateway_quota_borrowed_total`) so operators can see how often grace is used and adjust pricing accordingly.

## Consequences
* Better UX without sacrificing revenue protection
* Separate metric enables data-driven limit tuning
* Pure decision function fully unit-tested
