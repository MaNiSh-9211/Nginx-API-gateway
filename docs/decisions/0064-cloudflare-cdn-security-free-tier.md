# ADR-0064: Cloudflare Free CDN and edge security

## Status

Accepted

## Context

Production deployments need:

- Global CDN for static SPAs (demo + UAM frontends)
- DDoS and bot mitigation at the edge
- Correct client IP for WAF rate limits (ADR-0027)
- TLS for browsers without exposing origin directly

Cloudflare **Free** plan provides CDN, universal SSL, bot fight mode, basic rate limiting (1 rule), and DDoS protection at no cost.

## Decision

### 1. Dedicated `platform/cloudflare/` module

- `nginx/real-ip.conf` — official Cloudflare IP ranges + `CF-Connecting-IP`
- `nginx/cdn-static.conf` — `Cache-Control` for SPA assets
- `nginx/cdn-api-nostore.conf` — `no-store` for API gateway
- `nginx/origin-lockdown.conf` — optional allow Cloudflare-only (production)
- `scripts/sync-ips.ps1` / `sync-ips.sh` — refresh IPs from cloudflare.com/ips-v4

### 2. Gateway integration

- `gateway-edge/cloudflare/` copied into image; `nginx.conf` includes `real-ip.conf`
- `gateway-locations.conf` forwards `CF-Connecting-IP`, `CF-IPCountry`, `CF-Ray` to upstreams
- API responses: `Cache-Control: no-store` + `CDN-Cache-Control: no-store`

### 3. Frontend integration

- Demo + UAM nginx include `cdn-static.conf` for edge caching of JS/CSS/assets
- `/api/` proxy locations: `no-store` (auth never cached at CDN)

### 4. Operations (manual dashboard — free tier)

Documented in `platform/cloudflare/README.md`:

- Orange-cloud DNS (proxied records)
- SSL/TLS Full (strict) + Origin CA cert
- Bot Fight Mode, Browser Integrity Check, Always Use HTTPS
- One rate limit rule on `/api/auth/login`
- Optional Authenticated Origin Pulls

## Alternatives considered

- **Cloudflare only at DNS (grey cloud).** No CDN/DDoS; rejected.
- **AWS CloudFront.** Not free; more ops overhead for this stack.
- **Cache everything at CF.** Would cache authenticated API responses; rejected — origin sends `no-store` for `/api/`.

## Consequences

- Monthly IP sync recommended when Cloudflare publishes range changes.
- Origin lockdown breaks direct-to-origin access — enable only when all traffic flows through CF.
- Local dev unchanged; CF headers absent unless simulated.

## Related

- [ADR-0027](0027-trusted-proxy-real-ip-and-slowloris.md)
- [ADR-0025](0025-edge-security-headers.md)
- [ADR-0016](0016-tls-termination.md)
- [platform/cloudflare/README.md](../../platform/cloudflare/README.md)
