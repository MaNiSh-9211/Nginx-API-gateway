# ADR-0025 — Edge security headers (defense in depth)

**Status:** Accepted

## Context

The gateway terminates TLS and serves JSON API responses. Even when backends set
their own headers, the edge is the **authoritative** security boundary for
browser clients and security scanners. Missing headers are a common audit
finding (OWASP, Mozilla Observatory).

We could push header policy to each upstream microservice, but that duplicates
effort and drifts over time.

## Decision

**Set security headers at the NGINX edge** in `gateway-locations.conf` with
`always` so they apply to success and error responses:

| Header | Value | Why |
|--------|-------|-----|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Force HTTPS for 1 year |
| `X-Content-Type-Options` | `nosniff` | Block MIME sniffing |
| `X-Frame-Options` | `DENY` | Clickjacking protection |
| `X-XSS-Protection` | `1; mode=block` | Legacy browser XSS filter |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limit referrer leakage |
| `Permissions-Policy` | `geolocation=(), microphone=()` | Disable sensitive APIs |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'; sandbox` | API-only surface |

Additional edge controls in the same file:

- **Path traversal** regex on `$request_uri` before Lua (cheap first line)
- **`/metrics`** restricted to RFC1918 + loopback
- **Dotfiles** (`location ~ /\.`) return 404

Rust WAF (ADR-0006) handles injection; these headers handle **browser-class**
attacks and compliance checklists.

## Alternatives considered

- **Headers only from backends.** Inconsistent across services; gateway is the
  single public entry point — edge is the right place.
- **Permissive CSP for API JSON.** APIs do not execute scripts; `default-src
  'none'` is correct. A SPA on the same host would need a separate `location`.
- **Omit HSTS on HTTP-only dev.** Compose uses both :8080 and :8443; HSTS on
  HTTP port is harmless in dev; production should redirect HTTP→HTTPS (ADR-0016).

## Consequences

- Security scanners score the gateway well out of the box.
- Backends cannot override edge HSTS without duplicate `add_header` in nested
  locations — by design.
- API clients ignoring CSP are unaffected; browser embedders are protected.

## Related

- [ADR-0016 — TLS termination](0016-tls-termination.md)
- [ADR-0006 — WAF](0006-waf-aho-corasick.md)
- [docs/SECURITY.md](../SECURITY.md)
