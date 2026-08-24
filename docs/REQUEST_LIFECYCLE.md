# Request Lifecycle

> A single `GET /api/users/42` traced through every layer, with measured costs.

## Timeline

```
t=0.000µs  Client sends HTTPS request through Cloudflare
           ↓ TLS terminated at Cloudflare edge (or origin if grey-cloud)
           
t=~2ms     NGINX worker receives decrypted HTTP/1.1 or HTTP/2 frame
           ├── SO_REUSEPORT distributes to one of N workers
           └── Connection reused if keep-alive (typical: yes)

─── access_by_lua phase ─────────────────────────────────────────────

t=+0µs     gateway.lua:M.access() called
           │
           ├─ CORS preflight check                    ~10ns
           │  └─ OPTIONS? → get_cors_headers() → 204 exit
           │
           ├─ Strip X-User-Id, X-Home-Region         ~5ns
           │  (anti-spoofing: only gateway sets these)
           │
           ├─ Read body for POST/PUT/PATCH            ~200ns
           │  └─ First 8KB read; remainder spooled to disk
           │     (NUL-safe: length-delimited, not C-string)
           │
           ▼
t=+215ns   process_request(auth, path, body, ...) → RUST FFI
           │
           ├─── WAF ENGINE ──────────────────────── ~200ns ───┐
           │  ├ URI decode ×3 passes                          │
           │  ├ Aho-Corasick pattern scan                     │
           │  ├ Per-IP rate limit (SHM CAS)                   │
           │  ├ Body scan (NUL-safe, length-delimited)        │
           │  └ User-Agent check                              │
           │  ← Block? → return status (403)                  │
           │                                                  │
           ├─── JWT VALIDATION ─────────────────── ~150ns ────┤
           │  ├ Parse header: alg=HS256?, kid?                │
           │  ├ LRU cache lookup (8192 entries)               │
           │  ├ [HIT] Skip crypto entirely                    │
           │  ├ [MISS] base64 decode + HMAC-SHA256 (~2µs)    │
           │  ├ exp/nbf/iat checks                            │
           │  ├ Revocation snapshot check (~100ns arc-swap)   │
           │  └ TV floor check (snapshot lookup)              │
           │  ← Invalid? → return 401                         │
           │                                                  │
           ├─── ROUTING ──────────────────────────── ~50ns ───┤
           │  ├ Radix tree match on path                      │
           │  ├ Data-residency region check                   │
           │  └ Resolve service + timeout tier                │
           │  ← No match? → return 404                        │
           │                                                  │
           ├─── SENTINEL CHECK ────────────────────── ~1ns ───┤
           │  └ shed_anonymous()? → 503 at L3+                │
           │                                                  │
           ├─── RATE LIMIT ───────────────────────── ~15ns ───┤
           │  ├ SHM token bucket CAS per user                 │
           │  └ Exceeded? → return 429                        │
           │                                                  │
           ├─── QUOTA ────────────────────────────── ~50ns ───┤
           │  ├ Redis INCR pipeline (fail-open)              │
           │  └ Exceeded? → return 429 + Retry-After          │
           │                                                  │
           ├─── LOAD BALANCING ──────────────────── ~20ns ────┤
           │  ├ Ring hash by user_id (sticky)                 │
           │  ├ P2C: compare two candidates                   │
           │  ├ EWMA latency + confidence score penalty       │
           │  └ Latency debt ledger penalty                   │
           │  ← No healthy upstream? → return 503             │
           │                                                  │
           ├─── VALIDATION ──────────────────────── ~100ns ───┤
           │  └ Route policy? size/type/required checks       │
           │  ← Violation? → return 400/413/415               │
           │                                                  │
           ▼▼▼                                                │
       Return upstream="uam-backend:8080"                     │
              tier="normal"                                    │
              region="US"                                      │
                                                              │
t=+500ns   Back in LuaJIT                                      │
           ├ Set ngx.var.target_upstream                       │
           ├ Set ngx.var.target_tier                           │
           ├ Set X-Request-ID header                           │
           ├ Set X-User-Id / X-Home-Region headers             │
           └ ngx.exec("@up_normal")                             │

─── proxy_pass phase (@up_normal location) ─────────────────────────

t=+520ns   nginx resolves $gateway_upstream_base via resolver
           ├ DNS cached (valid=10s)
           └ Connects to uam-backend:8080 (keep-alive pool)

t=+800ns   Backend receives request
           ├ Validates JWT independently (defense-in-depth)
           ├ CSRF double-submit check
           ├ Rate limit (express-rate-limit + Redis store)
           └ Business logic → PostgreSQL query

t=~5ms     Backend responds 200 OK
           ├ Content-Type: application/json
           ├ Set-Cookie: uam_refresh (HttpOnly, SameSite)
           └ Body: {"user":{...},"accessToken":"..."}

─── log_by_lua phase ───────────────────────────────────────────────

t=~5ms     report_telemetry(status, latency_us, upstream)
           ├ SHM counters increment (requests, errors, latency)
           ├ Latency debt ledger update
           ├ EWMA latency record per upstream
           ├ OTLP span export (batched, async)
           ├ release_slot() [backpressure]
           └ JSON access log line emitted

─── Total measured cost ────────────────────────────────────────────

Edge hot path:      ~450–600 ns (p50), ~2 µs (p99 cache miss)
Full round trip:    ~5 ms (dominated by backend business logic)
Edge overhead:      <0.01% of total response time
```

---

## Failure Paths

What happens when things go wrong:

| Failure | Detection | Response | Recovery |
|---|---|---|---|
| **Redis unreachable** | Snapshot age >20s | Auth rejected (FAIL_CLOSED) or stale snapshot served | Auto-reconnect when reachable |
| **Backend timeout** | Tier timeout exceeded | 504 Gateway Timeout | Circuit breaker records failure |
| **Backend 5xx** | Status code | Proxied to client; CB records failure | CB opens after threshold |
| **All upstreams down** | LB returns None | 503 Service Unavailable | Active health probe auto-recovers |
| **Config invalid** | Deep validation rejects | 400 with error details | Previous config continues serving |
| **Config causes errors** | Sentinel detects posture ≥L3 within 300s of version change | Auto-revert to previous config | Loud log + metric |
| **Rate limiter Redis down** | Strict mode circuit OPEN | 503 (fail-closed) or degrade to local memory | Auto-recovery with backoff |
| **Quota Redis down** | INCR fails | Fail-open (allow) — billing guard, not security | Next successful INCR resumes |

---

## Cache Behavior

The L2 response cache (`proxy_cache`) handles the four classic cache threats:

| Threat | Mitigation | Config |
|---|---|---|
| **Stampede** (hot key expires, N requests rush backend) | `proxy_cache_lock on` — first request fills, others wait | `@up_normal` location |
| **Avalanche** (mass expiry) | `proxy_cache_use_stale` serves stale while refreshing | Same location |
| **Penetration** (random keys never cached) | Unknown routes 404 before proxying; 404s cached 1s | Router + cache config |
| **Poisoning** (authenticated responses cached for others) | `proxy_no_cache $gateway_skip_cache` map on Authorization header | Map at http level |
