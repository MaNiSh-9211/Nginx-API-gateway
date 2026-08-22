//! Routing Engine — Identity-based data residency + path-based service discovery
//!
//! Design:
//!   - Longest-prefix match on `path` → service name → `ServiceConfig`
//!   - JWT `home_region` field drives strict regional routing (data residency)
//!   - Falls back to `"US"` if no region is present in the token
//!   - Config read from `GLOBAL_CONFIG` (ArcSwap) — ~2 ns, zero allocation
//!
//! Data residency (see docs/decisions/0014-data-residency-identity-routing.md):
//!   This node serves only its own `GATEWAY_REGION`. A request whose home
//!   region differs is rejected with 403 so traffic (and the data it carries)
//!   never silently crosses a regional boundary. The special region `GLOBAL`
//!   acts as a wildcard on either side — a `GLOBAL` node serves every region,
//!   and a `GLOBAL`-homed identity may be served anywhere.
//!
//! The `cb_state` parameter allows the router to be aware of circuit-breaker
//! state for future adaptive routing (e.g., skip a region when its CB is open).

use crate::auth::UserIdentity;
use crate::config::{GatewayConfig, ServiceConfig, GLOBAL_CONFIG};
use arc_swap::ArcSwap;
use matchit::Router;
use std::sync::Arc;
use std::sync::OnceLock;

/// Match target stored in the radix tree: service name + timeout tier.
#[derive(Clone, Debug)]
pub struct RouteMeta {
    pub service_name: String,
    /// "fast" | "normal" | "slow" (ADR-0062).
    pub tier: String,
}

lazy_static::lazy_static! {
    pub static ref GLOBAL_ROUTER: ArcSwap<Router<RouteMeta>> =
        ArcSwap::from_pointee(Router::new());
}

/// This node's region, read once from `GATEWAY_REGION` (default `US`).
/// Cached because env vars are immutable at runtime and `env::var` both
/// allocates and takes a global lock — unacceptable on a per-request hot path.
fn current_region() -> &'static str {
    static REGION: OnceLock<String> = OnceLock::new();
    REGION
        .get_or_init(|| std::env::var("GATEWAY_REGION").unwrap_or_else(|_| "US".to_string()))
        .as_str()
}

pub fn update_router(config: &GatewayConfig) {
    let mut router = Router::new();
    for route in &config.routes {
        let meta = RouteMeta {
            service_name: route.service_name.clone(),
            tier: route.effective_tier().to_string(),
        };
        let path = if route.path_prefix.ends_with('/') {
            format!("{}*path", route.path_prefix)
        } else {
            format!("{}/*path", route.path_prefix)
        };
        let _ = router.insert(path, meta.clone());
        let _ = router.insert(route.path_prefix.clone(), meta);
    }
    GLOBAL_ROUTER.store(Arc::new(router));
}

pub struct ResolvedRoute {
    pub service: Option<ServiceConfig>,
    pub region: String,
    /// Timeout-policy tier for this route ("fast" | "normal" | "slow").
    pub tier: String,
}

pub fn route_request(path: &str, identity: Option<&UserIdentity>, _cb_state: i32) -> Result<ResolvedRoute, i32> {
    let config = GLOBAL_CONFIG.load();
    let (service, tier) = find_service(path, &config);

    let identity_region = identity.and_then(|id| id.home_region.as_deref());
    let region = resolve_region(identity_region, current_region())?;

    Ok(ResolvedRoute { service, region, tier })
}

/// Decide which regional upstream pool serves this request, enforcing data
/// residency. Returns the resolved region, or `Err(403)` on a cross-region
/// violation.
///
/// Residency protects *user* data, which only exists once a request is
/// authenticated (the JWT carries `home_region`). An **anonymous** request has
/// no identity and therefore no residency constraint, so it is served by the
/// node's own region — never 403'd. Defaulting anonymous traffic to a hardcoded
/// `"US"` would 403 every unauthenticated request on a non-US regional node,
/// including the login/register endpoints that must be reachable *without* a
/// token. A `GLOBAL` node (single-node/dev) has no region pool of its own, so
/// anonymous traffic there falls back to the `"US"` pool that always exists.
fn resolve_region(identity_region: Option<&str>, current: &str) -> Result<String, i32> {
    let required = match identity_region {
        Some(r) => r.to_string(),
        None if current == "GLOBAL" => "US".to_string(),
        None => current.to_string(),
    };

    // GLOBAL is an explicit wildcard on either side (ADR-0014).
    let allowed = required == current || current == "GLOBAL" || required == "GLOBAL";
    if !allowed {
        return Err(403);
    }

    Ok(required)
}

/// O(1) Radix tree match: find the service + tier for a given path.
fn find_service(path: &str, config: &GatewayConfig) -> (Option<ServiceConfig>, String) {
    let router = GLOBAL_ROUTER.load();
    if let Ok(matched) = router.at(path) {
        let svc = config.services.get(matched.value.service_name.as_str()).cloned();
        (svc, matched.value.tier.clone())
    } else {
        (None, "normal".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_region;

    #[test]
    fn authenticated_same_region_allowed() {
        assert_eq!(resolve_region(Some("EU"), "EU").unwrap(), "EU");
        assert_eq!(resolve_region(Some("US"), "US").unwrap(), "US");
    }

    #[test]
    fn authenticated_cross_region_rejected() {
        // The core residency guarantee: a US-homed token must not be served by EU.
        assert_eq!(resolve_region(Some("US"), "EU"), Err(403));
        assert_eq!(resolve_region(Some("EU"), "AP"), Err(403));
    }

    #[test]
    fn global_wildcard_on_either_side() {
        // GLOBAL node serves any identity; GLOBAL identity served anywhere.
        assert_eq!(resolve_region(Some("EU"), "GLOBAL").unwrap(), "EU");
        assert_eq!(resolve_region(Some("GLOBAL"), "US").unwrap(), "GLOBAL");
    }

    #[test]
    fn anonymous_served_locally_not_403() {
        // Regression: anonymous used to default to "US" and 403 on every non-US
        // regional node — breaking public + login endpoints. It must be served
        // by the node's own region instead.
        assert_eq!(resolve_region(None, "EU").unwrap(), "EU");
        assert_eq!(resolve_region(None, "AP").unwrap(), "AP");
        assert_eq!(resolve_region(None, "US").unwrap(), "US");
    }

    #[test]
    fn anonymous_on_global_node_uses_us_pool() {
        // A GLOBAL node has no pool of its own; anonymous falls back to "US",
        // which always exists in single-node/dev configs (no regression there).
        assert_eq!(resolve_region(None, "GLOBAL").unwrap(), "US");
    }
}
