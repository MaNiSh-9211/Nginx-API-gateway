# ADR-0065 — Control plane owns an isolated config store; gateway never touches user DB

**Status:** Accepted

## Context

The gateway is split into a data plane (`gateway-edge`) and a management plane
(`gateway-control-plane`, ADR-0011). The data plane must stay stateless and fast;
uam-backend (Express) is the system of record for identity (ADR-0050/0052) and owns
Postgres user data (`public.users`, `public.user_identity_indexes`).

Two questions need an explicit answer:

1. **Which components may hold a Postgres connection?**
   Only **uam-backend** (user data) and **gateway-control-plane** (its own state).
   `gateway-edge` and `gateway-sidecar` never connect to Postgres — they read config
   via HTTP/ArcSwap and Redis only.

2. **Does the control plane's config/audit history belong in the user DB?**
   No. Config revisions are the control plane's OWN operational state, not user data.
   Routing them through uam-backend would couple a management-plane concern into the
   auth service's schema and make the control plane depend on uam-backend's uptime
   for a write that is core to config management.

## Decision

- **The control plane owns a dedicated Postgres state store** (`src/store.rs`) for
  config revisions + audit trail. All objects live in an isolated **`control_plane`
  schema** — never `public`.
- **Durable-first writes:** `POST /config` and `POST /config/rollback` persist the
  revision to Postgres *before* activating the change in memory. If Postgres is
  configured but the write fails, the mutation is rejected with **503** (an
  un-audited config change is worse than a rejected one).
- **Boot-time restore:** on startup the control plane rebuilds in-memory history
  from Postgres so rollback keeps working across restarts; the initial `conf.d`
  snapshot is seeded as the first revision when the store is empty.
- **Hot path untouched:** `GET /config` remains a lock-free `ArcSwap` read (~2 ns).
  The store is touched only on writes, boot, and admin history/audit reads.
- **Least privilege:** production must scope a Postgres role to the `control_plane`
  schema only (see DDL in `src/store.rs`), so a compromised control plane cannot
  read `public.users`. TLS is enforced (`sslmode=require` via `PG_SSL`).

## Alternatives considered

- **Route audit through uam-backend internal endpoint.** Keeps the gateway
  DB-free literally, but couples config management to the auth service's uptime
  and mixes operational state into the user schema. Rejected.
- **etcd/Consul as control-plane state.** Strong distributed store, but adds a
  clustered dependency; a single-writer Postgres schema covers the need (ADR-0011).
- **In-memory history only.** Original design; history lost on restart, no audit
  trail. Rejected for production durability.

## Consequences

- Config history and audit are durable and survive restarts.
- Postgres now has two logical owners: uam-backend (`public`) and control-plane
  (`control_plane`) — kept isolated by schema + role. NetworkPolicy/role grants must
  allow control-plane → Postgres while denying `gateway-edge`/`gateway-sidecar`.
- Operators must provision `DATABASE_URL` + `PG_SSL` for the control plane and a
  least-privilege role (or accept `avnadmin` for dev).

## Related

- ADR-0011 (control plane config), ADR-0050/0052 (auth boundary),
  ADR-0044 (network segmentation), ADR-0013 (secrets via env).
