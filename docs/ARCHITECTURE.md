# Architecture

> Every box below is real code you can read. No magic. No hand-waving.

## System Overview

```mermaid
graph TB
    subgraph Internet["🌐 Internet"]
        User["👤 Client"]
        Bot["🤖 Bot / Attacker"]
    end

    subgraph CDN["Cloudflare Free Tier"]
        CF["Edge Cache + DDoS L3/L4"]
    end

    subgraph GatewayNode["gateway-edge : OpenResty + Rust FFI"]
        direction TB
        NGINX["NGINX Worker<br/>─────────────────<br/>access_by_lua │ proxy_pass<br/>log_by_lua"]
        
        subgraph LuaLayer["LuaJIT Bridge"]
            GL["gateway.lua<br/>──────────────<br/>CORS preflight<br/>CSRF bootstrap<br/>FFI dispatch"]
        end
        
        subgraph RustCore["librust_ext.so (Rust cdylib)"]
            direction LR
            subgraph SecurityPlane["🛡️ Security Plane"]
                WAF["WAF Engine<br/>Aho-Corasick<br/>~200ns"]
                JWT["JWT Validator<br/>HS256 + kid rotation<br/>LRU 8192"]
                Revoc["Revocation Snapshot<br/>arc-swap · ≤5s lag<br/>zero hot-path Redis"]
                Sentinel["Sentinel Mode<br/>adaptive posture<br/>L0→L4 hysteresis"]
            end
            subgraph TrafficPlane["🚦 Traffic Plane"]
                Router["Radix Router<br/>matchit · O(1)"]
                LB["Load Balancer<br/>P2C + EWMA + confidence<br/>+ canary % + debt ledger"]
                RL["Rate Limiter<br/>SHM token bucket<br/>CAS ~15ns"]
                Quota["Quota Enforcer<br/>Redis INCR/EXPIRE NX<br/>grace borrowing"]
                BP["Backpressure<br/>SHM admission control"]
            end
            subgraph DataPlane["📦 Data Plane"]
                Val["Body Validator<br/>size/type/required"]
                Cache["L2 Response Cache<br/>nginx proxy_cache"]
                Debt["Latency Debt Ledger<br/>SLA violation tracking"]
                EntropyG["Entropy Guard<br/>response anomaly"]
            end
        end

        TierLocs["Timeout Tiers<br/>┌ @up_fast   1s/5s/5s<br/>├ @up_normal 3s/60s/60s<br/>└ @up_slow   5s/300s/300s"]
    end

    subgraph ControlPlane["gateway-control-plane : Actix-web"]
        ConfigAPI["Config API<br/>HMAC-signed<br/>dry-run + diff"]
        RevokeAPI["Revoke API<br/>HMAC-signed"]
        Store["Postgres Store<br/>versioned history<br/>audit trail"]
    end

    subgraph Sidecar["config-sidecar : Rust"]
        SC["Poll → atomic write<br/>every 5s"]
    end

    subgraph UAM["uam-backend : Node.js / Express"]
        Auth["Auth Service<br/>register/login/refresh<br/>OAuth Google+GitHub"]
        Session["Session Manager<br/>TV floors · JTI tracking"]
    end

    subgraph Backends["Business APIs"]
        DemoAPI["demo-backend"]
    end

    subgraph External["☁️ Managed Services"]
        PG[("PostgreSQL<br/>Aiven")]
        Redis[("Redis<br/>Upstash")]
        GF[("Grafana Cloud<br/>Tempo · Mimir · Loki")]
    end

    User --> CF
    Bot --> CF
    CF --> NGINX
    NGINX --> GL --> RustCore
    NGINX --> TierLocs
    TierLocs -->|"proxy_pass $target_upstream"| UAM
    TierLocs --> DemoAPI
    
    Edge -.->|OTLP traces/metrics/logs| GF
    UAM -.->|OTLP| GF
    CP -.->|OTLP| GF
    
    UAM --> PG
    UAM --> Redis
    CP --> Redis
    CP --> PG
    
    Sidecar -->|GET /config| ControlPlane
    Sidecar -->|atomic write| Edge

    style Edge fill:#1a1a2e,color:#e0e0e0,stroke:#e94560
    style RustCore fill:#16213e,color:#e0e0e0,stroke:#0f3460
    style ControlPlane fill:#16213e,color:#e0e0e0,stroke:#0f3460
    style UAM fill:#1b2845,color:#e0e0e0
    style External fill:#0d1117,color:#8b949e
    style Sentinel fill:#2d1b4e,color:#c4b89c
```

---

## Request Lifecycle

Every request traverses this exact pipeline. Each step shows its measured cost.

```mermaid
sequenceDiagram
    participant C as Client
    participant N as nginx worker
    participant L as LuaJIT
    participant R as Rust FFI
    participant B as Backend
    participant RD as Redis

    C->>N: GET /api/users/42<br/>Authorization: Bearer eyJ...
    
    Note over N,L: ─── access_by_lua phase ───
    N->>L: access_by_lua_block
    L->>L: CORS preflight check<br/>(204 if OPTIONS)
    L->>L: Strip X-User-Id/X-Home-Region<br/>(anti-spoofing)
    L->>L: Read body (first 8KB for WAF)
    
    L->>R: process_request(auth,path,body,...)<br/>═══ RUST HOT PATH ═══
    
    rect rgb(30, 30, 50)
        Note over R: ── WAF ── (~200ns)
        R->>R: URI decode ×3 passes
        R->>R: Aho-Corasick pattern match
        R->>R: Per-IP rate limit (SHM CAS)
        R->>R: Body scan (NUL-safe)
        
        Note over R: ── JWT Validation ── (~150ns cache hit)
        R->>R: Header parse + alg pinning
        R->>R: HMAC-SHA256 verify (constant-time)
        R->>R: exp/nbf/iat checks
        R->>R: LRU cache lookup
        R->>R: Revocation snapshot check (~100ns)
        R->>R: TV floor check (snapshot)
        
        Note over R: ── Routing ── (~50ns)
        R->>R: Radix tree match → service + tier
        
        Note over R: ── Rate Limit ── (~15ns)
        R->>R: SHM token bucket CAS
        
        Note over R: ── Quota ── (~50ns when enabled)
        R->>RD: INCR quota:{svc}:{user}:{day}
        RD-->>R: count
        
        Note over R: ── Load Balancing ── (~20ns)
        R->>R: Ring hash + P2C + EWMA<br/>× confidence score<br/>× latency debt penalty
        R-->>L: upstream="uam-backend:8080"<br/>region="US" tier="normal"
    end
    
    L->>L: Set target_upstream/target_tier<br/>Set X-Request-ID/X-User-Id headers
    L->>L: ngx.exec("@up_" .. tier)

    Note over N,B: ─── proxy_pass phase ───
    N->>B: GET /api/users/42<br/>X-Request-ID: abc123<br/>X-User-Id: user42<br/>X-Tier: normal
    
    B-->>N: 200 OK {"data":...}
    N-->>C: 200 OK (with CORS headers,<br/>security headers, X-Cache-Status)

    Note over N,R: ─── log_by_lua phase ───
    N->>L: log_by_lua_block
    L->>R: report_telemetry(status, latency_us, upstream)
    R->>R: Latency debt ledger update
    R->>R: EWMA latency record
    R->>R: OTLP span export (batched)
    L->>L: release_slot() [backpressure]
```

---

## Adaptive Defense Posture (Sentinel Mode)

The gateway's immune system. Signals fuse into one posture; effects cascade automatically.

```mermaid
stateDiagram-v2
    [*] --> L0_NORMAL

    state "L0 NORMAL" as L0_NORMAL
    state "L2 ELEVATED<br/>WAF budget ×0.5" as L2_ELEVATED  
    state "L3 GUARDED<br/>+ anonymous shed" as L3_GUARDED
    state "L4 LOCKDOWN<br/>auth-only traffic" as L4_LOCKDOWN

    L0_NORMAL --> L2_ELEVATED : single minor signal<br/>(waf spike / sat high)
    L0_NORMAL --> L3_GUARDED : major signal<br/>(50% upstreams down)
    L2_ELEVATED --> L3_GUARDED : second minor signal<br/>or any escalation
    L3_GUARDED --> L4_LOCKDOWN : double major<br/>(upstream down + errors)

    L4_LOCKDOWN --> L3_GUARDED : 60s clean
    L3_GUARDED --> L2_ELEVATED : 60s clean
    L2_ELEVATED --> L0_NORMAL : 60s clean
    L3_GUARDED --> L0_NORMAL : signals clear + 60s

    note right of L2_ELEVATED
        Self-calibrating thresholds:
        median + k×MAD over rolling
        256-sample window.
        Zero operator tuning needed.
    end note

    note left of L4_LOCKDOWN
        Effects at L4:
        • WAF budget ×0.25
        • Anonymous requests shed
        • Only authenticated pass
    end note
```

---

## Revocation Flow (Zero Hot-Path Redis)

How tokens are revoked in ≤5 seconds without touching Redis on the hot path.

```mermaid
sequenceDiagram
    participant Admin as Operator
    participant CP as Control Plane
    participant RD as Redis (Upstash)
    participant Edge as Gateway Worker
    participant Snap as Revocation Snapshot<br/>(arc-swap, per-worker)

    Admin->>CP: POST /revoke {jti:"abc", ttl:600}
    CP->>CP: HMAC verify + nonce check
    CP->>RD: SET gateway:revoked:jti:abc EX 600
    CP->>RD: ZADD gateway:revocation:index score=expiry member=key
    
    Note over Edge: Background sync thread (every 5s)
    Edge->>RD: ZRANGEBYSCORE index last-sync..+inf WITHSCORES
    RD-->>Edge: [(key, expiry), ...]
    Edge->>Edge: Build immutable snapshot
    Edge->>Edge: arc_swap.store(new_snapshot)
    Note over Edge: Propagation delay ≤ 5s
    
    User->>Edge: GET /api/data (Bearer token jti:abc)
    Edge->>Snap: is_revoked("abc", hash)?
    Snap-->>Edge: true
    Edge-->>User: 401 Unauthorized
```

---

## Deployment Topology

```mermaid
graph LR
    subgraph Internet
        Users["👥 Users"]
    end

    subgraph Cloudflare["Cloudflare Free"]
        CFProxy["Orange-cloud proxy<br/>DDoS L3/L4 · TLS termination"]
    end

    subgraph RegionUS["Region: US (Render / EC2)"]
        subgraph Node1["Gateway Node 1"]
            FE1["uam-frontend :80"]
            DE1["demo-frontend :80"]
            GW1["gateway-edge :8080<br/>OpenResty + Rust"]
            SC1["config-sidecar"]
            CP1["control-plane :8081"]
            UB1["uam-backend :8080"]
            DB1["demo-backend :8080"]
        end
    end

    subgraph CloudServices["Managed Services"]
        Upstash[("Upstash Redis<br/>TLS · auth · TTL")]
        Aiven[("PostgreSQL<br/>TLS · schema-isolated")]
        Grafana[("Grafana Cloud<br/>Tempo · Mimir · Loki")]
    end

    Users --> CFProxy
    CFProxy --> FE1
    CFProxy --> GW1
    
    FE1 -->|proxy_pass /api/| GW1
    DE1 -->|proxy_pass /api/| GW1
    GW1 --> UB1
    GW1 --> DB1
    
    SC1 -->|poll config| CP1
    SC1 -->|write config.json| GW1
    
    GW1 -->|quota INCR| Upstash
    GW1 -->|snapshot sync| Upstash
    UB1 -->|sessions/tokens| Upstash
    CP1 -->|nonce store| Upstash
    CP1 -->|config history| Aiven
    UB1 -->|users/sessions| Aiven
    
    GW1 -.->|OTLP| Grafana
    UB1 -.->|OTLP| Grafana
    CP1 -.->|OTLP| Grafana
```

---

## Graceful Degradation Matrix

What happens when each dependency fails? This is the complete policy map.

| Dependency | Consumer | On failure | Policy | User impact |
|---|---|---|---|---|
| **Redis** (Upstash) | edge revocation snapshot | Sync fails → snapshot goes stale | Fail-closed if >20s old + FAIL_CLOSED=1; else serve stale | 401 after staleness threshold |
| **Redis** (Upstash) | edge rate-limit fleet sync | Sync fails → local CAS only | Fail-open (local limits still enforced) | None |
| **Redis** (Upstash) | edge quota counters | INCR times out | Fail-open (allow) | None |
| **Redis** (Upstash) | uam session/cache pool | Connection error | Circuit breaker → fail-open silently | None (cache miss) |
| **Redis** (Upstash) | uam distributed rate limit | Circuit OPEN | **Fail-closed** (strict mode) or degrade to local | 503 or degraded limiting |
| **PostgreSQL** | uam identity DB | Connection refused | Boot exits(1) — identity is critical | Service down |
| **PostgreSQL** | cp config history | Write fails before apply | Reject change (fail-closed for auditability) | Config push rejected |
| **PostgreSQL** | cp durable store | Pool timeout | In-memory history fallback | Rollback unavailable |
| **Backend API** | edge proxy | Timeout / 5xx | Circuit breaker opens → skip upstream; try next in ring | 503 if no healthy upstream |
| **Control plane** | sidecar config fetch | Poll timeout | Keep last known-good config | Stale routes continue serving |

---

## Key Design Decisions

| # | Decision | Approach | Why |
|---|----------|----------|-----|
| 002 | Data-plane language | Rust cdylib via Lua FFI | Memory safety + zero-GC + NGINX ecosystem |
| 003 | Hot-path design | Lock-free atomics, SHM mmap | ~450 ns p50, zero allocation per request |
| 005 | JWT validation | Local HS256, 8192-entry LRU | No network round-trip per request |
| 006 | WAF | Aho-Corasick automaton | Single-pass, zero heap, ~200 ns |
| 009 | Load balancing | Consistent hash + P2C + EWMA | Sticky routing, latency-aware, fault-tolerant |
| 010 | Backpressure | SHM admission control | Prevents cascading failure under load |
| 038 | Revocation keys | `jti` preferred, sha256(token) fallback | Opaque, collision-free, per-token precision |
| 053 | Token-version floor | Redis counter per user | O(1) kill-all-sessions on password reset |
| 066 | Revocation snapshot | arc-swap, background sync every 5s | Zero hot-path Redis; fail-closed guard |
| 0071 | Sentinel Mode | Cross-signal adaptive posture L0–L4 | Self-calibrating defense without tuning |
| 0072 | Soft circuit breaker | Confidence-scored routing | Continuous health vs binary ejection |
| 0073 | Quota borrowing | Grace % of future allowance | Better UX than hard cutoff |
| 0075 | Gradient concurrency | TCP Vegas applied to HTTP proxy | Limit self-discovers backend capacity |
| 0076 | Single-flight collapsing | In-flight registry, leader/follower | Eliminates thundering herd at source |
| 0077 | Latency debt ledger | SLA violations accumulate as decaying debt | Natural credit market for upstream traffic |

Full decision index: [`docs/decisions/README.md`](docs/decisions/README.md)
