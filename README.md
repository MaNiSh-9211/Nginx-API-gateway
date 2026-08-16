# nginx-rust-api-gateway

A production-grade API gateway built on **OpenResty (NGINX + LuaJIT)** with a **Rust FFI data-plane extension** and a full **User Access Management (UAM)** service. Every significant architectural decision is documented in [`docs/decisions/`](docs/decisions/) (66 ADRs).

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
MongoDB Atlas                                                           │
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
| Token revocation | Redis `EXISTS` on `jti` or `sha256(token)` | Per-token precision; no prefix collision; opaque key |
| Session invalidation | Token-version floor in Redis | O(1) kill-all-sessions on password reset |
| Observability | Prometheus pull + JSON access logs + OTel tail sampling | Scrape-based liveness, queryable logs, sampled traces |

Full decision index: [`docs/decisions/README.md`](docs/decisions/README.md)

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
