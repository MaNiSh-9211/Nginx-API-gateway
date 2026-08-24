# ADR-0056 — UAM Helm chart as separate release

**Status:** Accepted

## Context

UAM (`services/uam/backend`, `services/uam/frontend`, PostgreSQL) must deploy independently from the
API gateway in production — different scale, lifecycle, and blast radius
(ADR-0052). Docker Compose overlays suffice for dev; Kubernetes needs a chart.

## Decision

Add `platform/deploy/helm/uam/` as a **standalone Helm release** in namespace `uam`:

| Workload | Role |
|----------|------|
| `services/uam/backend` | Credentials, JWT issuance, OAuth |
| `services/uam/frontend` | SPA + nginx same-origin proxy to gateway |
| `mongodb` | Optional StatefulSet (enabled by default) |

Cross-release contracts:

- `JWT_ACCESS_SECRET` == gateway `JWT_SECRET` (ADR-0050)
- `ADMIN_API_KEY` == gateway admin key (revocation)
- Frontend nginx `proxy_pass` → `gateway.<api-gateway-ns>.svc.cluster.local`
- Control-plane route `/api/auth/` → `uam-backend.uam.svc.cluster.local`

Production values enable `AUTH_OMIT_REFRESH_IN_BODY` and `COOKIE_SECURE` (ADR-0055).

## Alternatives considered

- **Subchart of api-gateway** — couples release cycles; rejected.
- **External managed MongoDB only** — supported via `mongodb.enabled=false` + custom `DATABASE_URL).

## Consequences

- Operators install two releases: `api-gateway`, then `uam`.
- PostgreSQL credentials live in `uam-secrets` Secret.
