# uam-backend

**Deployable repo:** User Access Management API (register, login, refresh, OAuth, sessions).

Issues HS256 access tokens consumed by `gateway-edge`. **Never expose publicly** — only via gateway `/api/auth/*`.

## Build

TypeScript 7 (Go-native `tsc`) — source in `src/`, output in `dist/`:

```bash
npm install
npm run build
npm run typecheck
npm test        # build + unit tests for the Redis circuit breaker
```

```bash
docker build -t uam-backend:latest .
```

## Run (standalone smoke — includes PostgreSQL)

```bash
docker compose up --build
```

## Environment

Copy `.env.example` → `.env`. **`JWT_ACCESS_SECRET` must match gateway `JWT_SECRET`** (see `dev/.env` and `gateway-edge/.env`).

Prometheus metrics: `GET /metrics` (scrape from internal network only) — includes
`uam_redis_*` gauges for the Redis circuit breaker (state, in-flight, rolling p99/error
rate, cumulative success/error/timeout/rejection counters).

Redis is protected by a local (process-local) circuit breaker
(`src/config/redisCircuitBreaker.ts`, tunable via `REDIS_CB_*` env vars, see `.env.example`).
Every cache and rate-limit command routes through it; timeouts are enforced by ioredis
`commandTimeout` (default 5000ms). Rate limiting fails closed while the circuit is OPEN;
the cache fails open.

Full stack with gateway: [`../dev/README.md`](../dev/README.md)

## Production

Helm: [`../platform/deploy/helm/uam/`](../platform/deploy/helm/uam/) — ClusterIP service, managed PostgreSQL.
