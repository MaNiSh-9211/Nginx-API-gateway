# uam-backend

**Deployable repo:** User Access Management API (register, login, refresh, OAuth, sessions).

Issues HS256 access tokens consumed by `gateway-edge`. **Never expose publicly** — only via gateway `/api/auth/*`.

## Build

TypeScript 7 (Go-native `tsc`) — source in `src/`, output in `dist/`:

```bash
npm install
npm run build
npm run typecheck
```

```bash
docker build -t uam-backend:latest .
```

## Run (standalone smoke — includes MongoDB)

```bash
docker compose up --build
```

## Environment

Copy `.env.example` → `.env`. **`JWT_ACCESS_SECRET` must match gateway `JWT_SECRET`** (see `dev/.env` and `gateway-edge/.env`).

Prometheus metrics: `GET /metrics` (scrape from internal network only).

Full stack with gateway: [`../dev/README.md`](../dev/README.md)

## Production

Helm: [`../platform/deploy/helm/uam/`](../platform/deploy/helm/uam/) — ClusterIP service, managed MongoDB.
