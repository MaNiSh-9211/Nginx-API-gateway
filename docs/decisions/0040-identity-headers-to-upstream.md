# ADR-0040 — Forward sanitized identity headers to upstreams

**Status:** Accepted

## Context

After JWT validation, backends often need the authenticated principal without
re-parsing the `Authorization` header. Common patterns:

- Microservices trust the gateway and read `X-User-Id` / `X-Home-Region`.
- Re-validating JWT in every service duplicates crypto work and key distribution.
- Forwarding the raw `Bearer` token to upstreams expands the blast radius if a
  backend is compromised or logs headers carelessly.

## Decision

On admitted requests, the gateway sets (when identity is present):

| Header | Source | Notes |
|--------|--------|-------|
| `X-User-Id` | JWT `sub` (sanitized) | CRLF/null rejected at validation — [ADR-0005](0005-local-jwt-validation.md) |
| `X-Home-Region` | JWT `home_region` | Used for residency routing — [ADR-0014](0014-data-residency-identity-routing.md) |

Rust writes values into FFI output buffers; Lua sets NGINX variables and
`proxy_set_header` in `gateway-locations.conf`. **The raw JWT is never
forwarded.**

Anonymous / public routes omit these headers (empty variables).

## Alternatives considered

- **Forward `Authorization` unchanged.** Simple but leaks bearer tokens to every
  hop; rejected for defense in depth.
- **Re-validate JWT upstream.** Correct in zero-trust mesh, but adds latency and
  key sprawl; we optimize for gateway-terminated auth ([ADR-0005](0005-local-jwt-validation.md)).
- **Opaque session cookie.** Good for browser apps; JWT header model is our
  primary API client path.
- **gRPC metadata only.** Out of scope for this HTTP gateway.

## Consequences

- Backends can authorize on `X-User-Id` when they trust the private network /
  mTLS boundary ([guides/MTLS.md](../guides/MTLS.md)).
- Operators must strip or overwrite these headers at the edge if clients could
  spoof them — the gateway **clears** client values at ingress and re-sets from JWT
  ([ADR-0048](0048-circuit-breaker-half-open-and-header-stripping.md)).
- Slightly wider FFI surface (`user_id_out`, `home_region_out` buffers).

## Related

- [ADR-0005 — Local JWT validation](0005-local-jwt-validation.md)
- [ADR-0014 — Data residency](0014-data-residency-identity-routing.md)
- [`../../services/gateway/edge/lua/gateway.lua`](../../services/gateway/edge/lua/gateway.lua)
