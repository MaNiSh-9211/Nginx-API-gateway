# ADR-0068: Dynamic CORS from Config

## Status: Accepted

## Context
CORS origins were hardcoded in backend code, requiring redeploy to add an origin.

## Decision
CORS policy lives in the hot-reloaded gateway config. Preflight OPTIONS requests are answered at the edge (204/403) without reaching backends. Origins, methods, headers, max-age and credentials all config-driven.

## Consequences
* Origin changes propagate via hot-reload (no restart)
* Preflight handled before backends (zero load)
* Wildcard + credentials auto-corrected
