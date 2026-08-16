# Operations Runbook

Quick reference for running the gateway in production. For deployment checklist
see [PRODUCTION.md](PRODUCTION.md). For architecture see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Health endpoints

| Endpoint | Use | Pass criteria |
|----------|-----|---------------|
| `GET /health` | **Liveness** — restart if down | `{"status":"healthy",...}` |
| `GET /ready` | **Readiness** — remove from LB if down | `{"status":"ready"}` |
| `GET /metrics` | Prometheus scrape | `gateway_up 1`, `gateway_config_ready 1` |

Kubernetes:
```yaml
livenessProbe:
  httpGet: { path: /health, port: 8080 }
  initialDelaySeconds: 10
readinessProbe:
  httpGet: { path: /ready, port: 8080 }
  initialDelaySeconds: 15
  periodSeconds: 5
```

---

## Config change procedure

1. Update JSON in `gateway-control-plane/conf.d/` (or your GitOps repo).
2. Sign and push:
   ```bash
   BODY=$(cat new-config.json)
   SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$ADMIN_API_KEY" | awk '{print $2}')
   curl -X POST http://control-plane:8081/config \
     -H "Content-Type: application/json" \
     -H "X-Admin-Signature: sha256=$SIG" \
     -d "$BODY"
   ```
3. Sidecars detect new version within ~5 s; gateways hot-swap within ~6 s.
4. Verify: `curl http://gateway:8080/ready` and check `gateway_config_ready 1`.

**Rollback:**
```bash
curl -X POST http://control-plane:8081/config/rollback \
  -H "X-Admin-Signature: sha256=$(echo -n '' | openssl dgst -sha256 -hmac "$ADMIN_API_KEY" | awk '{print $2}')"
```

→ [ADR-0011](decisions/0011-control-plane-gitops.md)

---

## Token revocation (logout / compromise)

Revoke by JWT ID (preferred) or full token hash. Same HMAC signing as config push.

```bash
BODY='{"jti":"session-abc-123","ttl_secs":3600}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$ADMIN_API_KEY" | awk '{print $2}')
curl -X POST http://control-plane:8081/revoke \
  -H "Content-Type: application/json" \
  -H "X-Admin-Signature: sha256=$SIG" \
  -d "$BODY"
```

Set `ttl_secs` to the token's remaining lifetime (`exp - now`). Gateways check
Redis on JWT cache miss; hot tokens may be accepted until the LRU entry expires
(typically minutes). For immediate effect on a hot token, lower LRU TTL or
restart workers (last resort).

→ [ADR-0038](decisions/0038-revocation-key-scheme.md), [ADR-0039](decisions/0039-control-plane-revoke-api.md)

---

---

## JWT key rotation

1. Add new key to `jwt_keys` map with a `kid` in the config push.
2. Auth server starts issuing tokens with `kid` header pointing to new key.
3. Old tokens (no `kid` or old `kid`) remain valid until `exp`.
4. Remove old `kid` from config after all old tokens have expired.

→ [ADR-0005](decisions/0005-local-jwt-validation.md)

---

## Incident response

### High 5xx rate (`GatewayHighErrorRate` alert)

1. Check `gateway_circuit_breaker_state` — if `1` (OPEN), upstreams are failing.
2. `docker compose logs gateway` / check upstream health.
3. Circuit breaker auto-probes after 10 s (half-open). Upstreams recover → closed.

### High latency (`GatewayHighP99Latency` alert)

1. Check `gateway_in_flight / gateway_max_concurrency` — near 1.0 → backpressure.
2. Scale horizontally (more gateway nodes) or raise `global_max_concurrency`.
3. Check upstream EMA — slow backend may be getting traffic via LB.

### WAF spike (`GatewayHighWafBlocks` alert)

1. Check `rate(gateway_waf_blocks_total[1m])` in Grafana.
2. Correlate with access logs (`uri`, `ua` fields).
3. Consider tightening GeoIP/blocklist at edge (ADR-0018).

### Config not loading (`/ready` 503)

1. Check sidecar logs: `docker compose logs config-sidecar`
2. Verify shared volume has `config.json`: sidecar healthcheck
3. Verify control plane: `curl http://control-plane:8081/health`

---

## Scaling

| Scale | Action |
|-------|--------|
| More RPS | Add gateway nodes (stateless data plane) |
| More regions | Deploy PoP per region + GeoDNS |
| Config CP load | Sidecar model = O(nodes) not O(nodes×workers) |
| Global rate limits | Approximate per-node; or add Redis layer for specific keys |

→ [ADR-0018](decisions/0018-multi-region-anycast.md), [ADR-0012](decisions/0012-config-distribution-sidecar-file-watch.md)

---

## Useful commands

```bash
make up          # start stack
make test        # E2E suite (24 tests)
make test-unit   # Rust unit tests
make logs        # tail gateway + control-plane + sidecar
make chaos       # chaos test script
make load        # k6 load test
```

---

## Metrics cheat sheet

| Metric | Meaning |
|--------|---------|
| `gateway_requests_total` | All requests through hot path |
| `gateway_requests_401_total` | Auth failures |
| `gateway_requests_429_total` | Rate limited |
| `gateway_requests_5xx_total` | Upstream/gateway 5xx |
| `gateway_latency_us` | Histogram (µs) |
| `gateway_in_flight` | Current concurrency |
| `gateway_max_concurrency` | Configured ceiling |
| `gateway_waf_blocks_total` | WAF rejections |
| `gateway_circuit_breaker_state` | 0=closed, 1=open, 2=half-open |
| `gateway_config_ready` | 1 = config loaded |
