# nginx-rust-api-gateway

A production-grade API gateway built on **OpenResty (NGINX + LuaJIT)** with a **Rust FFI data-plane extension** and a full **User Access Management (UAM)** service. Every significant architectural decision is documented in [`docs/decisions/`](docs/decisions/) (78 ADRs).

---

## What this is

A complete, self-contained API gateway platform that handles authentication, authorisation, routing, rate limiting, WAF, and observability — all at sub-millisecond latency. It is not a wrapper around an existing gateway; the data-plane logic (JWT validation, WAF, load balancing, revocation) is implemented from scratch in Rust and called from NGINX via a Lua FFI bridge at ~300–600 ns per request.

---

## Architecture

```
Client
  │
  ▼
gateway-edge  ──────────────────────────────────────────────────────────┐
  OpenResty (NGINX + LuaJIT)                                            │
  └─ gateway.lua  (thin FFI bridge)                                     │
       └─ librust_ext.so  (Rust cdylib)                                 │
            ├─ WAF (Aho-Corasick multi-pattern, ~200 ns)                │
            ├─ JWT validation (HS256, LRU cache, Redis revocation)      │
            ├─ Routing (radix tree, data-residency enforcement)         │
            ├─ Rate limiting (shared-memory token bucket, ~15 ns)       │
            ├─ Load balancing (consistent hash + EMA + circuit breaker) │
            └─ Backpressure (admission control, in-flight counter)      │
                                                                        │
  proxy_pass ──────────────────────────────────────────────────────────►│
                                                                        │
gateway-sidecar  (Rust)                                                 │
  └─ Polls control plane every 5s, writes config.json atomically        │
                                                                        │
gateway-control-plane  (Rust / Actix-web)                               │
  └─ Config API (versioned, HMAC-signed), POST /revoke                  │
                                                                        │
uam-backend  (Node.js / Express / TypeScript)                           │
  └─ Register, login, refresh, OAuth (Google / GitHub), logout          │
  └─ JWT issuance (HS256), token revocation, CSRF, rate limiting        │
                                                                        │
uam-frontend  (React / Vite)                                            │
  └─ Login / register / profile UI, served behind the gateway           │
                                                                        │
Redis  (Upstash / managed)                                              │
  └─ Revocation keys, token-version floor, distributed rate limits      │
                                                                        │
PostgreSQL (Aiven)                                                           │
  └─ User accounts, refresh tokens, session tracking                    │
```

---

## Key design decisions

| Decision | Approach | Why |
|----------|----------|-----|
| Data-plane language | Rust cdylib called via Lua FFI | Hot-path memory safety + zero-GC + NGINX ecosystem |
| JWT validation | Local HMAC-SHA256, 8 192-entry LRU | No network round-trip per request; revocation is Redis-backed on cache miss |
| WAF | Aho-Corasick automaton | Single-pass, zero heap allocation, ~200 ns |
| Rate limiting | Shared-memory mmap token bucket | Cross-worker without network; ~15 ns per check |
| Load balancing | Consistent hash + EWMA + circuit breaker | Sticky routing, latency-aware selection, fault tolerance |
| Config distribution | Sidecar file-watch (not per-worker polling) | N requests/interval to control plane instead of N×workers |
| Token revocation | Zero-hot-path-Redis snapshot via arc-swap | ~100 ns auth; 5 s propagation bound; fail-closed guard |
| Sentinel Mode | Cross-signal adaptive defense posture (L0–L4) | Self-calibrating thresholds via median+MAD baselines |
| Soft circuit breaker | Confidence-scored routing (0–100 per upstream) | Continuous health weighting instead of binary ejection |
| Active health checks | Per-worker prober thread, cross-worker SHM | Auto-recovery without traffic |
| Canary splitting | Version labels + % bucketing + sticky header/cookie | Safe rollouts with instant fallback |
| Timeout tiers | fast/normal/slow nginx internal locations | Per-route timeout budgets without config reload |
| Request validation | Per-route body policy (size/type/required fields) | Catches client errors at edge before backends |
| Quota enforcement | Redis INCR + EXPIRE NX per-user daily counter | Fleet-wide exact counting with grace borrowing |
| Adaptive concurrency | Gradient limiter (TCP Vegas applied to HTTP proxy) | Limit self-discovers backend capacity |
| Single-flight collapsing | In-flight registry collapses identical GETs | Eliminates thundering herd at the source |
| Latency debt ledger | SLA violations accumulate as decaying debt | Natural credit market for upstream traffic |
| Session invalidation | Token-version floor in Redis | O(1) kill-all-sessions on password reset |
| Observability | Prometheus pull + JSON access logs + OTel tail sampling | Scrape-based liveness, queryable logs, sampled traces |

Full decision index: [`docs/decisions/README.md`](docs/decisions/README.md)

---

## Live Configuration Updates — Zero Downtime, No Restart Required

One of the most important things this gateway does is **update its routing rules, upstream servers, rate limits, and service configuration completely live — while traffic is flowing — with zero downtime and without restarting or reloading NGINX or any gateway process.**

This is not a trivial feature. Most gateways require a process reload, a deployment, or at minimum a brief connection drop to pick up new config. This system does none of those things. Here is exactly how it works, end to end.

### The Problem It Solves

A production gateway runs multiple NGINX worker processes (one per CPU core). If you want to change routing — say, add a new upstream, change a rate limit, or redirect a path — traditional approaches have ugly trade-offs:

- **NGINX reload (`nginx -s reload`)** — graceful, but still briefly drops keep-alive connections, creates a new worker generation, and is coarse-grained (you reload everything just to change one route)
- **Baked-into-image config** — immutable and simple but means a full redeploy for any change
- **Per-worker HTTP polling** — works but every worker on every node hammers the config server simultaneously, creating thundering herd problems at scale (10 nodes × 16 workers = 160 requests per poll interval)

This system uses none of those approaches.

### How It Actually Works

The system splits config distribution into three independent stages, each doing exactly one job:

```
You push a config change
        │
        ▼
┌─────────────────────────────────┐
│   gateway-control-plane         │
│   (Rust / Actix-web)            │
│                                 │
│   Stores versioned config in    │
│   memory (ArcSwap — lock-free   │
│   reads at ~2 ns)               │
│                                 │
│   GET /config returns the       │
│   current snapshot              │
└──────────────┬──────────────────┘
               │ HTTP poll every 5 seconds
               ▼
┌─────────────────────────────────┐
│   gateway-sidecar               │
│   (ONE per gateway node)        │
│                                 │
│   Compares version string.      │
│   If changed: writes new JSON   │
│   to a temp file, then does     │
│   an atomic rename() onto       │
│   /etc/gateway/config.json      │
│                                 │
│   Workers never see a           │
│   half-written file.            │
└──────────────┬──────────────────┘
               │ file appears on disk
               ▼
┌─────────────────────────────────┐
│   gateway-edge workers          │
│   (N worker processes)          │
│                                 │
│   Background thread in each     │
│   worker stat()s the file once  │
│   per second (free — OS dentry  │
│   cache, no disk I/O)           │
│                                 │
│   On mtime change: parse JSON,  │
│   inject secrets from env,      │
│   rebuild the radix router,     │
│   then ArcSwap the new config   │
│   into the global pointer       │
│                                 │
│   Next request (arriving        │
│   microseconds later) reads     │
│   the new config with zero      │
│   locking overhead (~2 ns)      │
└─────────────────────────────────┘
```

### Stage 1 — Control Plane: Lock-Free Config Storage

The control plane (`gateway-control-plane`) stores the active config snapshot in an [`ArcSwap`](https://docs.rs/arc-swap) — a lock-free atomic pointer. Reads are ~2 nanoseconds regardless of how many nodes are reading simultaneously. There is no mutex on the read path.

When you push a new config via `POST /config` (signed with HMAC-SHA256 to prevent unauthorised changes), the control plane:
1. Validates the new snapshot
2. Injects the JWT secret from the server environment (secrets are **never** served over the wire — the config JSON never contains credentials)
3. Stores the new config in a versioned history (default: last 20 versions)
4. Swaps it into the `ArcSwap` pointer atomically

At any point you can roll back instantly with `POST /config/rollback`.

### Stage 2 — The Sidecar: One Fetcher Per Node, Not Per Worker

Each gateway node runs exactly **one** `gateway-sidecar` process. This is the only process that talks to the control plane over HTTP.

Without this, if you had 10 gateway nodes each running 16 worker processes, all polling every 5 seconds, the control plane would receive 160 requests per polling interval. With the sidecar, it receives exactly 10 — one per node, regardless of how many workers are running.

The sidecar polls every 5 seconds, compares the config version string, and only writes to disk when the version actually changes. The write is **atomic**: it writes to a sibling temp file first (`config.json.tmp`), then calls `rename()` onto the real path (`config.json`). On Linux/POSIX, `rename()` is atomic at the filesystem level — a worker reading the file will either see the old version or the new version, never a partial file in between.

### Stage 3 — Workers: File Watch With No Locks, No Network

Each NGINX worker process has a background thread (spawned in Rust on startup) that calls `stat()` on the config file once per second. This is essentially free — the OS serves `stat()` from the dentry cache without touching the disk.

When the file's modification time changes, the worker:
1. Reads and parses the new JSON config
2. Injects the JWT secret and key-rotation keys from its own environment variables (credentials are never in the file)
3. Rebuilds the radix-tree router for path matching
4. Calls `ArcSwap::store()` to atomically swap the new config into the process-wide global pointer

The next request that arrives — which could be microseconds later — loads the new config via `ArcSwap::load()` at ~2 nanoseconds. No locking. No connection drops. No reload signal. The old config is dropped from memory automatically when the last in-flight request that was using it completes.

### What You Can Change Without Any Restart or Downtime

- **Add or remove upstream servers** — new upstreams become available to the load balancer on the next config poll cycle (~6 seconds end-to-end: 5s sidecar poll + 1s worker stat)
- **Add or remove routes** — new URL paths start routing immediately
- **Change rate limits** — new limits apply to the next request window
- **Change authentication requirements** — make a route public or require auth
- **Roll out a new JWT signing key** — add it as a named key in `jwt_keys` (kid-based rotation), workers pick it up and validate tokens signed with the new key; old tokens signed with the old key continue to work until they expire
- **Roll back any of the above** — one API call, instant, no deployment needed

### What This Does NOT Require

- ❌ No `nginx -s reload`
- ❌ No process restart
- ❌ No deployment pipeline run
- ❌ No connection drops or in-flight request interruption
- ❌ No coordination between workers (each independently reads the same file)
- ❌ No Redis or database for config state (config lives in the control plane's memory, distributed via files)

### Propagation Timeline

```
You call POST /config
        │
        │  < 1ms: control plane updates ArcSwap
        │
        │  up to 5s: sidecar polls, detects version change,
        │             writes new config.json atomically
        │
        │  up to 1s: each worker's background thread detects mtime change,
        │             parses new config, rebuilds router, swaps ArcSwap
        │
        ▼
All workers serving new config
Total time: 0–6 seconds, zero traffic disruption
```

### Security: Secrets Never Touch the Config Wire

Credentials (JWT secret, signing keys) are **deliberately absent** from everything the control plane serves. The control plane strips `jwt_secret` and `jwt_keys` from all API responses. Each gateway worker injects secrets from its own environment variables after reading the config file. This means:

- A stolen config file contains no credentials
- A compromised control plane API response contains no credentials
- Rotating a JWT secret means updating an environment variable on the gateway nodes, not pushing a config change

This design is documented in [ADR-0013](docs/decisions/0013-secrets-via-environment-not-config-wire.md).

---

## Performance targets

| Stage | Budget |
|-------|--------|
| Backpressure check | ~5 ns |
| WAF (URI + body) | ~200 ns |
| JWT validation (LRU hit) | ~50 ns |
| JWT validation (cache miss + Redis) | ~2–5 µs |
| Routing | ~10 ns |
| Rate limiting | ~15 ns |
| Load balancing | ~20 ns |
| **Total Rust hot path** | **~300–600 ns** |

---

## Repository layout

```
nginx-rust-api-gateway/
├── gateway-edge/           # NGINX + Rust FFI data plane
│   ├── rust-ext/           # Rust cdylib (auth, WAF, routing, RL, LB)
│   ├── lua/                # Lua FFI bridge
│   ├── nginx.conf          # TLS, epoll, access log format
│   └── gateway-locations.conf
├── gateway-sidecar/        # Config fetcher (Rust)
├── gateway-control-plane/  # Config + revoke API (Rust / Actix)
├── uam-backend/            # Auth service (Node.js / TypeScript)
├── uam-frontend/           # Login UI (React / Vite)
├── demo-backend/           # Sample upstream for local testing
├── demo-frontend/          # Test console for local testing
├── dev/                    # Docker Compose + E2E test scripts
├── platform/               # Helm charts, Prometheus, Grafana, OTel
└── docs/                   # Architecture docs + 66 ADRs
```

---

## Quick start

### Prerequisites
- Docker Desktop (or Docker Engine + Compose v2)
- PowerShell 5+ (Windows) or Bash (Linux/macOS)

### 1. Configure secrets

```bash
cp dev/.env.example dev/.env
# Fill in MONGODB_URI, Redis credentials, JWT_SECRET, etc.
```

### 2. Start the full stack

```bash
cd dev
docker compose -f docker-compose.yml \
               -f docker-compose.testing.yml \
               -f docker-compose.uam.yml \
               up --build
```

### 3. Services

| URL | Service |
|-----|---------|
| `http://localhost:18083` | Gateway |
| `http://localhost:8090` | Demo test console |
| `http://localhost:8091` | UAM login UI |
| `http://localhost:9090` | Prometheus |
| `http://localhost:3000` | Grafana |

### 4. Run tests

```powershell
cd dev
powershell -File test.ps1               # Gateway E2E (39 checks)
powershell -File scripts/test-uam.ps1  # UAM integration (22 checks)
powershell -File scripts/test-all.ps1  # Both
```

---

## Components

### gateway-edge
OpenResty + Rust FFI data plane. The only entry point for all API traffic. Handles TLS termination, WAF, authentication, routing, rate limiting, load balancing, and caching. See [`gateway-edge/README.md`](gateway-edge/README.md).

### gateway-sidecar
Lightweight Rust daemon (one per node) that polls the control plane and writes the gateway config file atomically. Decouples config polling from per-worker frequency. See [`gateway-sidecar/README.md`](gateway-sidecar/README.md).

### gateway-control-plane
Actix-web server. Stores versioned gateway config (routes, upstreams, rate-limit settings). Exposes `POST /revoke` for token invalidation and `POST /config` for config pushes (HMAC-signed). See [`gateway-control-plane/README.md`](gateway-control-plane/README.md).

### uam-backend
Node.js / Express / TypeScript auth service. Handles user registration, login, email verification, password reset, OAuth (Google/GitHub), JWT issuance, token refresh, and logout. Publishes revocations to the control plane. See [`uam-backend/README.md`](uam-backend/README.md).

### uam-frontend
React SPA with login, registration, and profile management. Served behind the gateway; all API calls go through `/api/*`. See [`uam-frontend/`](uam-frontend/).

---

## Security

- JWT `alg: HS256` enforced; `alg:none` and RS256→HS256 confusion rejected
- Token revocation via `jti` or SHA-256(token) in Redis
- Token-version floor for instant kill-all-sessions
- HMAC-signed admin mutations with timestamp + nonce (replay protection)
- Client `X-User-Id` / `X-Home-Region` headers stripped at ingress, re-set from JWT
- WAF blocks SQLi, XSS, path traversal, SSRF patterns
- Structured JSON access logs with `X-Request-ID` on every response
- W3C `traceparent` passed through for distributed tracing

See [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/PRODUCTION_READY.md`](docs/PRODUCTION_READY.md).

---

## Production deployment

Each service has an independent Dockerfile. See [`docs/PRODUCTION.md`](docs/PRODUCTION.md) for the full checklist.

Helm charts are in [`platform/deploy/helm/`](platform/deploy/helm/).

---

## Documentation

| Topic | Link |
|-------|------|
| Full architecture | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Request lifecycle (7 stages) | [`docs/REQUEST_LIFECYCLE.md`](docs/REQUEST_LIFECYCLE.md) |
| All 66 ADRs | [`docs/decisions/README.md`](docs/decisions/README.md) |
| Production checklist | [`docs/PRODUCTION_READY.md`](docs/PRODUCTION_READY.md) |
| Security | [`docs/SECURITY.md`](docs/SECURITY.md) |
| Performance | [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) |
| Operations | [`docs/OPERATIONS.md`](docs/OPERATIONS.md) |

---

## License

[MIT](LICENSE)
