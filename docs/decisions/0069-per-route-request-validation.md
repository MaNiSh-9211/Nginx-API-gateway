# ADR-0069: Per-Route Request Body Validation

## Status: Accepted

## Context
WAF blocks attacks but not malformed-but-benign traffic; every invalid body still hits backends.

## Decision
Routes carry optional `validation` policies enforcing max body size (413), JSON content-type (415), and required top-level fields with primitive types (400). Enforced at the edge before proxying.

## Consequences
* Catches most client errors before they reach services
* Pure decision function fully unit-tested
* Zero cost for routes that opt out
