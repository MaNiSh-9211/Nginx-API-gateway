# Cloudflare Free Tier — CDN + Security for this stack

Put **Cloudflare in front of your public DNS** (orange cloud / proxied) to get the free CDN, DDoS protection, and edge TLS without changing application code.

## What you get on Free ($0)

| Feature | Use in this repo |
|---------|------------------|
| **Global CDN** | Caches static JS/CSS/images from demo + UAM frontends |
| **DDoS protection** | Always on at edge |
| **Universal SSL** | HTTPS for `yourdomain.com` at Cloudflare |
| **Bot Fight Mode** | Block obvious bots before origin |
| **Browser Integrity Check** | Challenge suspicious browsers |
| **Always Use HTTPS** | Redirect HTTP to HTTPS |
| **DNSSEC** | Enable in DNS settings |
| **1 rate limiting rule** | Protect `/api/auth/login` |
| **Scrape Shield** | Hotlink protection, email obfuscation |

Paid features (WAF custom rules, advanced bot management) are **not** required for this guide.

## Architecture

```
Browser ──HTTPS──► Cloudflare (CDN + security) ──► Origin (gateway / frontends)
                         │
                         ├─ caches static assets (Cache-Control from nginx)
                         ├─ TLS termination (visitor side)
                         └─ forwards CF-Connecting-IP, CF-Ray, CF-IPCountry
```

Origin nginx/gateway config lives in:

- `platform/cloudflare/nginx/` — source snippets
- `gateway-edge/cloudflare/` — copied into gateway image
- `demo-frontend/cloudflare/`, `uam-frontend/cloudflare/` — SPA CDN headers

## 1. DNS (Free)

1. Add your domain to Cloudflare (Free plan).
2. Point records to your origin (LoadBalancer IP or tunnel):

| Record | Type | Proxy | Points to |
|--------|------|-------|-----------|
| `api` | A / CNAME | Proxied (orange) | Gateway LB |
| `app` | A / CNAME | Proxied | UAM frontend |
| `demo` | A / CNAME | Proxied | Demo frontend |

3. Enable **DNSSEC** (DNS → Settings).

## 2. SSL/TLS (Free)

Cloudflare Dashboard → **SSL/TLS**:

- **Encryption mode:** `Full (strict)` — origin must present a valid cert (Let's Encrypt or Cloudflare Origin CA).
- **Always Use HTTPS:** On
- **Automatic HTTPS Rewrites:** On
- **Minimum TLS Version:** 1.2

### Origin certificate (free)

**SSL/TLS → Origin Server → Create Certificate** (15-year Cloudflare Origin CA).

Install on gateway:

```bash
# Mount as gateway TLS secret (Helm: gateway.tls.secretName)
/etc/nginx/certs/server.crt
/etc/nginx/certs/server.key
```

## 3. Security (Free)

**Security → Settings**

- Security Level: *Medium*
- Challenge Passage: 30 minutes
- Browser Integrity Check: **On**
- **Bot Fight Mode:** **On** (Security → Bots)

**Security → Scrape Shield**

- Email Address Obfuscation: On
- Hotlink Protection: On

### Optional: Authenticated Origin Pulls (free)

Cloudflare → SSL/TLS → Origin Server → **Authenticated Origin Pulls: On**

Only Cloudflare can connect with a valid client cert. Complements `origin-lockdown.conf` on the gateway.

### Origin lockdown (recommended production)

Uncomment in `gateway-edge/gateway-locations.conf`:

```nginx
# include cloudflare/origin-lockdown.conf;
```

This allows only Cloudflare IP ranges + private networks (K8s health checks).

Regenerate IP lists monthly:

```powershell
.\platform\cloudflare\scripts\sync-ips.ps1
```

## 4. CDN caching (Free)

Origin sends `Cache-Control`; Cloudflare Free respects it.

| Path | Origin header | Edge behavior |
|------|---------------|---------------|
| `/assets/*` (Vite) | `max-age=31536000, immutable` | Long cache |
| `*.css`, `*.js` | `max-age=86400` | 1 day |
| `*.html` | `max-age=300` | 5 min (fast deploys) |
| `/api/*` | `no-store` | Never cached |

### Cache Rules (dashboard)

**Caching → Cache Rules** (free tier: limited rules):

1. **Bypass API** — If URI Path starts with `/api/` → Bypass cache
2. **Cache static** — If URI Path matches `\.(js|css|png|svg|woff2?)$` → Eligible for cache

### Tiered Cache

Free plan uses Cloudflare's network; no config needed.

## 5. Rate limiting (Free — 1 rule)

**Security → WAF → Rate limiting rules**

Example:

- Expression: `(http.request.uri.path contains "/api/auth/login")`
- Requests: 10 per minute per IP
- Action: Block

Gateway Rust rate limits still apply at origin (defense in depth).

## 6. Helm production

```yaml
# values-production.yaml
gateway:
  tls:
    enabled: true
    secretName: cloudflare-origin-tls

cloudflare:
  enabled: true
  originLockdown: true   # uncomment include in gateway-locations when true
```

## 7. Local dev

Docker Compose does **not** proxy through Cloudflare. Real IP uses Docker `X-Forwarded-For`; Cloudflare `real-ip.conf` is harmless when traffic is not from CF edges.

Simulate HTTPS headers from Cloudflare:

```yaml
# dev/docker-compose.cloudflare.yml (optional)
services:
  uam-frontend:
    environment:
      - SIMULATE_CF_HTTPS=1
```

Frontends already enable HSTS when `X-Forwarded-Proto: https`.

## 8. Verify

```bash
curl -I https://api.yourdomain.com/health
# expect: cf-ray, cf-cache-status (DYNAMIC for API)

curl -I https://app.yourdomain.com/assets/index-*.js
# expect: cf-cache-status: HIT (after second request)
```

Check real IP in gateway logs: `"ip"` should be the visitor IP, not a Cloudflare edge IP.

## Related

- [ADR-0064](../../docs/decisions/0064-cloudflare-cdn-security-free-tier.md)
- [ADR-0027](../../docs/decisions/0027-trusted-proxy-real-ip-and-slowloris.md)
- [ADR-0025](../../docs/decisions/0025-edge-security-headers.md)
