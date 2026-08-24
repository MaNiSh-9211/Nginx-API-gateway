# Diagrams

> Every diagram is generated from real code. If it's drawn here, it works.

---

## 1. Security Defense-in-Depth

Seven layers of protection between attacker and data.

```mermaid
graph LR
    subgraph L1["Layer 1 · Network"]
        CF["Cloudflare Free<br/>DDoS L3/L4<br/>TLS termination"]
    end
    subgraph L2["Layer 2 · Transport"]
        TLS["TLS 1.2/1.3<br/>ECDHE ciphers<br/>HSTS preload"]
    end
    subgraph L3["Layer 3 · Edge WAF"]
        AC["Aho-Corasick<br/>pattern scan"]
        IPRL["Per-IP rate limit<br/>SHM CAS ~15ns"]
        TRAV["Traversal guard<br/>raw + decoded"]
        BSCAN["Body scan<br/>NUL-safe 8KB"]
    end
    subgraph L4["Layer 4 · Auth"]
        JWTV["JWT HS256<br/>alg pinned<br/>kid rotation"]
        REVOC["Revocation snapshot<br/>≤5s propagation"]
        TVF["Token-version floor<br/>kill-all-sessions"]
    end
    subgraph L5["Layer 5 · Authorization"]
        CSRF["CSRF double-submit<br/>cookie+header match"]
        RES["Data-residency<br/>region enforcement"]
    end
    subgraph L6["Layer 6 · Adaptive"]
        SENT["Sentinel Mode<br/>L0→L4 posture"]
        CONFCB["Soft circuit breaker<br/>confidence scoring"]
        GRAD["Gradient concurrency<br/>self-discovering limit"]
    end
    subgraph L7["Layer 7 · Backend"]
        VAL["Input validation<br/>zod schema"]
        RLIM["Auth rate limiter<br/>20/hr strict"]
        BCOST["bcrypt cost 12<br/>+ pepper"]
    end

    L1 --> L2 --> L3 --> L4 --> L5 --> L6 --> L7

    style L3 fill:#2d1b4e,color:#c4b89c
    style L4 fill:#1a1a2e,color:#e0e0e0
    style L6 fill:#16213e,color:#e0e0e0
```

---

## 2. Config Distribution Pipeline

How a config change reaches every worker without downtime.

```mermaid
sequenceDiagram
    participant Op as Operator
    participant CP as Control Plane<br/>(Actix-web)
    participant PG as PostgreSQL<br/>(audit trail)
    participant SC as Sidecar<br/>(per node)
    participant F as config.json<br/>(atomic rename)
    participant W1 as Worker 1
    participant W2 as Worker N

    Op->>CP: POST /config?dry_run=1<br/>X-Admin-Signature: HMAC(...)
    CP->>CP: validate_config()<br/>· duplicate routes?
    CP->>CP: diff_report(current, next)
    CP-->>Op: {valid, errors, warnings, diff}

    Op->>CP: POST /config (apply)
    CP->>PG: record(version, actor, snapshot)
    PG-->>CP: OK
    CP->>CP: ArcSwap::store(new_config)
    CP-->>Op: 200 {"diff": {...}}

    Note over SC: every 5s
    SC->>CP: GET /config<br/>X-Config-Read-Token: ...
    CP-->>SC: JSON config
    SC->>F: write temp → rename (atomic)

    Note over W1: file watcher (every 1s)
    F-->>W1: mtime changed
    W1->>W1: serde_json parse
    W1->>W1: update_router()
    W1->>W1: GLOBAL_CONFIG.store()

    Note over W2: same process independently
    F-->>W2: mtime changed
    W2->>W2: reload (identical)
```

---

## 3. Single-Flight Collapsing

100 identical concurrent GETs → exactly 1 backend hit.

```mermaid
sequenceDiagram
    participant C1 as Client 1
    participant C2 as Client 2..99
    participant SF as Single-Flight<br/>(FxHashMap)
    participant BE as Backend

    C1->>SF: try_flight(key="GET:/api/users/42")
    SF-->>C1: Leader (registered)
    Note over C1: Proxies to backend

    par 99 followers arrive
        C2->>SF: try_flight(same key)
        SF-->>C2: Follower (registered on slot)
        C2->>C2: spin-wait (1μs→500μs backoff)
    end

    C1->>BE: GET /api/users/42 (single request)
    BE-->>C1: 200 OK
    C1->>SF: complete_flight(key, 200)
    SF-->>C2: status=200 (shared to all followers)
    C2-->>C2: serve cached response copy
```

---

## 4. Gradient Concurrency Limiter

The limit self-discovers the backend's true carrying capacity.

```mermaid
graph TD
    subgraph Request["Each Request Completion"]
        START["Request completes"] --> RTT["measure RTT (µs)"]
        RTT --> MINRTT["update min_rtt<br/>= min(min_rtt×0.99 + rtt×0.01, rtt)"]
    end

    MINRTT --> GRADIENT

    subgraph GRADIENT["Gradient Algorithm"]
        direction LR
        EXPECTED["expected = limit × min_rtt / rtt"] --> COMPARE{"inflight < expected?"}
        COMPARE -->|Yes: headroom| GROW["limit += α (grow slowly)"]
        COMPARE -->|No: queue building| SHRINK["limit ×= β (shrink 75%)"]
    end

    GROW --> CLAMP["clamp(1, 10_000)"]
    SHRINK --> CLAMP
    CLAMP --> STORE["atomic store"]

    style GROW fill:#1b4332,color:#d8f3dc
    style SHRINK fill:#6a040f,color:#fff
```

---

## 5. Quota Grace Borrowing

Users who exhaust their allowance get grace before hard rejection.

```mermaid
flowchart TD
    REQ["Authenticated request"] --> INCR["Redis INCR<br/>gateway:quota:{svc}:{day}:{user}"]
    INCR --> COUNT["counter returned"]

    COUNT --> CHECK{"count <= daily_limit?"}
    CHECK -->|Yes| ALLOW["✅ Allow"]
    CHECK -->|No| BORROW{"borrow_percent > 0<br/>AND count <= limit +<br/>limit × borrow%?"}
    BORROW -->|Yes| GRACE["⚠️ Allow (BORROWED)<br/>metric: borrowed_total++"]
    BORROW -->|No| REJECT["❌ Reject (429)<br/>metric: rejected_total++"]

    style ALLOW fill:#1b4332,color:#d8f3dc
    style GRACE fill:#856404,color:#fff3cd
    style REJECT fill:#6a040f,color:#fff
```

---

## 6. Latency Debt Ledger

Upstreams accumulate debt when slow; debt decays; selection prefers low-debt.

```mermaid
flowchart LR
    subgraph Observation
        RESP["Response completes"] --> MEASURE["actual_us vs budget_us"]
        MEASURE -->|"actual > budget"| ACCRUE["debt += overage<br/>(capped at 10s)"]
        MEASURE -->|"actual ≤ budget"| NOOP["no new debt"]
    end

    subgraph Decay["Every observation"]
        ACCRUE --> DECAY["debt ×= 0.5^(elapsed/half_life)<br/>half_life = 30s"]
    end

    subgraph Selection
        DECAY --> SCORE["LB composite score:<br/>EMA × (1 + confidence_deficit/50)<br/>× (1 + debt_us/10_000_000)"]
        SCORE --> PICK{"lower score wins"}
    end

    style ACCRUE fill:#6a040f,color:#fff
    style DECAY fill:#1b4332,color:#d8f3dc
```

---

## 7. Revocation Snapshot (Zero Hot-Path Redis)

Tokens revoked fleet-wide in ≤5 seconds without any Redis call on the hot path.

```mermaid
flowchart TB
    subgraph Publisher["Publishers (control-plane / uam-backend)"]
        REVOKE["POST /revoke"] --> SET["SET gateway:revoked:jti:{id} EX ttl"]
        TV["Password reset"] --> SETTV["SET gateway:user:tv:{sub} version"]
        SET --> ZADD1["ZADD gateway:revocation:index expiry key"]
        SETTV --> ZADD2["ZADD gateway:tv:index now_ms user_id"]
    end

    subgraph EdgeWorker["Gateway Worker (per NGINX worker)"]
        SYNC["Sync thread (every 5s)"] -->|"ZRANGEBYSCORE deltas"| REDIS[("Redis")]
        SYNC --> BUILD["Build immutable snapshot"]
        BUILD --> SWAP["arc_swap.store(snapshot)"]
    end

    subgraph HotPath["Request hot path (~100ns)"]
        VALIDATE["validate_token()"] --> LOOKUP["snapshot.revoked.get(key)?"]
        LOOKUP -->|"found & not expired"| REJECT["401"]
        LOOKUP -->|"not found"| PASS["proceed"]
    end

    REDIS -.-> SYNC
    SWAP -->|"~100ns read"| LOOKUP
```

---

## 8. Response Entropy Guard

Detecting the invisible failure: 200 OK with garbage.

```mermaid
flowchart LR
    subgraph Per_Response
        BODY["Response body sample"] --> SHANNON["Shannon entropy<br/>Σ -p·log₂(p) per byte"]
        SHANNON --> WINDOW["observe() into<br/>32-sample ring window"]
    end

    subgraph Detection["Collapse detection"]
        WINDOW --> MEDIAN["median of window"]
        MEDIAN --> CHECK{"median was >1.0<br/>AND current < median×0.3<br/>AND current <1.0"}
        CHECK -->|Yes| ALERT["🚨 Upstream returning garbage"]
        CHECK -->|No| OK["normal variation"]
    end

    subgraph Examples["Entropy examples"]
        E1["Healthy JSON: ~4.5 bits/byte"]
        E2["Base64 blob: ~6.0 bits/byte"]
        E3["Identical error page: ~0 bits ← COLLAPSED"]
    end
```
