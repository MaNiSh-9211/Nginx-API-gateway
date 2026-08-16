# ADR-0035 — Routing: `matchit` radix tree over regex or NGINX locations

**Status:** Accepted

## Context

Every request must map `path_prefix` → `service_name` → `ServiceConfig`. Routing
runs on the hot path (~10 ns target) and must update **without process restart**
when config changes (ADR-0011).

Options:

- **NGINX `location` blocks** per service — requires reload per route change
- **Regex table** in Rust — flexible but backtracking risk and harder to predict
  worst-case latency
- **Radix tree (trie)** — O(path length) longest-prefix match, no backtracking

## Decision

Use **`matchit`** (radix tree router) in Rust, rebuilt atomically when config
changes via `GLOBAL_ROUTER: ArcSwap<Router<String>>`.

```rust
// On config load: rebuild router from routes[], store in ArcSwap
router.insert("/api/v1/", "api-v1-service".to_string())?;
let service = GLOBAL_ROUTER.load().at(path).ok()?.value;
```

- **Longest-prefix wins** — `/api/v1/orders` matches `/api/v1/` before `/`
- **Hot-swap** — new `Arc<Router>` swapped in ~2 ns read on hot path
- **No NGINX reload** — all routes live in JSON from control plane

Regional routing (`home_region` vs `GATEWAY_REGION`) is separate from path
matching ([ADR-0014](0014-data-residency-identity-routing.md)).

## Alternatives considered

- **NGINX locations only.** Standard pattern but couples routing to NGINX
  config syntax and `reload`; rejected for GitOps JSON model.
- **`regex` crate per route.** Powerful (path params) but ReDoS and per-route
  scan; `matchit` supports params if needed later with bounded cost.
- **Linear scan over `routes[]`.** Fine for &lt;10 routes; does not scale to
  hundreds of prefixes.

## Consequences

- Route changes propagate with config sidecar poll (~5 s), not NGINX reload.
- Path parameters (e.g. `/users/{id}`) can be added via `matchit` without
  changing architecture.
- Cost: router rebuild on every config version — cheap (microseconds, rare).

## Related

- [ADR-0011 — Control plane GitOps](0011-control-plane-gitops.md)
- [ADR-0014 — Data residency](0014-data-residency-identity-routing.md)
- [services/gateway/edge/rust-ext/src/router.rs](../../services/gateway/edge/rust-ext/src/router.rs)
