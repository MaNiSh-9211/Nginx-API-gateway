# ADR-0014 — Data residency via identity-based regional routing

**Status:** Accepted

## Context

Regulations (GDPR and similar) and latency both argue for keeping a user's
traffic and data in their home region. The gateway must guarantee that a request
is served by the correct region's upstreams and must not silently send a user's
data across a regional boundary.

## Decision

Routing is **identity-driven**:

- The JWT carries `home_region` (`EU` / `US` / `AP`). The router resolves the
  service by path (radix match) and the upstream **pool by `home_region`**.
- Each node has a `GATEWAY_REGION`. **Strict enforcement:** if a request's
  `home_region` does not match the node's region, it is rejected with **403** —
  data never crosses the boundary by accident.
- `GLOBAL` is an explicit wildcard on either side: a `GLOBAL` node serves all
  regions (single-node/dev), and a `GLOBAL`-homed identity may be served
  anywhere. Region codes are normalized so the JWT value, `GATEWAY_REGION`, and
  the `regional_upstreams` keys all use the same vocabulary (`EU`/`US`/`AP`),
  fixing an earlier mismatch (`EU` vs `eu-central-1`).
- `GATEWAY_REGION` is read **once** and cached (it is immutable at runtime),
  keeping the hot path free of `env::var` calls.
- **Anonymous requests** carry no identity and therefore no residency
  constraint, so they are served by the node's own region rather than being
  forced to a default region. Forcing anonymous traffic to a hardcoded `"US"`
  would 403 every unauthenticated request on a non-US regional node — including
  the login/register endpoints that must be reachable *without* a token. A
  `GLOBAL` node has no region pool of its own, so its anonymous traffic falls
  back to the `"US"` pool that always exists. Authenticated cross-region requests
  are still strictly rejected with 403.

In `docker-compose.multi-region.yml`, three PoPs (`gateway-eu/us/ap`) each pin a
region, so residency is exercised end to end.

## Alternatives considered

- **Route by client GeoIP / source network.** Approximates location but is
  spoofable and wrong for travelling users / VPNs; it does not reflect where the
  *account's* data legally lives. Identity (the token) is the authoritative
  signal.
- **Silent cross-region proxy on mismatch.** Convenient, but exactly the
  compliance violation we must prevent. We fail closed (403) instead.
- **Per-route region config instead of per-identity.** Doesn't capture that the
  same endpoint must serve different users in different regions; identity-based
  selection does.

## Consequences

- A clear, enforceable residency guarantee with a single vocabulary across token,
  node, and config.
- Flexible dev/edge behavior via the `GLOBAL` wildcard.
- Cost: tokens must include an accurate `home_region`, and the front door
  (anycast/GeoDNS, ADR-0018) should already steer users to their regional PoP so
  legitimate requests rarely hit the 403 cross-region guard.
