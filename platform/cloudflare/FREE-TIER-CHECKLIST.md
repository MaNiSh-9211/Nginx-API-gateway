# Cloudflare Free dashboard checklist
# Tick each item after enabling in the Cloudflare dashboard (Free plan).

## DNS
- [ ] Domain on Cloudflare Free plan
- [ ] A/CNAME records for api, app, demo — **Proxied** (orange cloud)
- [ ] DNSSEC enabled

## SSL/TLS
- [ ] Encryption mode: **Full (strict)**
- [ ] Always Use HTTPS: **On**
- [ ] Automatic HTTPS Rewrites: **On**
- [ ] Minimum TLS: **1.2**
- [ ] Origin CA certificate installed on gateway (`gateway.tls.enabled` in Helm)

## Security
- [ ] Security Level: Medium
- [ ] Bot Fight Mode: **On**
- [ ] Browser Integrity Check: **On**
- [ ] Authenticated Origin Pulls (optional): **On**
- [ ] Scrape Shield: Hotlink + Email obfuscation **On**

## Caching
- [ ] Caching level: Standard
- [ ] Cache rule: Bypass `/api/*`
- [ ] Cache rule: Cache static extensions (js, css, images)

## Rate limiting (1 free rule)
- [ ] `POST /api/auth/login` — 10 req/min/IP — Block

## Origin
- [ ] Run `platform/cloudflare/scripts/sync-ips.ps1` monthly
- [ ] Enable `origin-lockdown.conf` on gateway when origin is CF-only
- [ ] Verify gateway logs show real visitor IP (not CF edge)
