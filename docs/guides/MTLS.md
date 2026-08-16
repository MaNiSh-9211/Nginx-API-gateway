# mTLS & Zero-Trust Guide

How to enable mutual TLS (client certificate authentication) and layer it with
the gateway's existing controls. For TLS termination rationale see
[ADR-0016](../decisions/0016-tls-termination.md).

---

## When to use mTLS

| Scenario | Recommendation |
|----------|----------------|
| Service-to-service (internal APIs) | mTLS at gateway **or** service mesh sidecar |
| Partner / B2B APIs | mTLS at gateway with partner CA |
| Public mobile/web apps | JWT (ADR-0005) — mTLS does not work in browsers |
| Zero-trust internal fleet | mTLS + JWT (defense in depth) |

mTLS proves **who connected** (client cert identity). JWT proves **who the
request is for** (user/service claims). They solve different problems.

---

## Enable client certificate verification

### 1. Issue certificates

```bash
# Dev CA + server + client (OpenSSL)
openssl req -x509 -newkey rsa:4096 -keyout ca.key -out ca.crt -days 365 -nodes -subj "/CN=Gateway Dev CA"
openssl req -newkey rsa:2048 -keyout server.key -out server.csr -nodes -subj "/CN=gateway.local"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365
openssl req -newkey rsa:2048 -keyout client.key -out client.csr -nodes -subj "/CN=partner-app"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days 365
```

### 2. Mount certs

```yaml
# Kubernetes Secret
kubectl create secret tls gateway-tls --cert=server.crt --key=server.key -n api-gateway
kubectl create secret generic gateway-ca --from-file=ca.crt=ca.crt -n api-gateway
```

Mount at `/etc/nginx/certs/` in the gateway pod.

### 3. Uncomment mTLS in `gateway/nginx.conf`

```nginx
ssl_client_certificate /etc/nginx/certs/ca.crt;
ssl_verify_client on;   # or 'optional' to allow JWT-only clients too
ssl_verify_depth 2;
```

`optional` lets browsers (no client cert) use JWT while partners present a cert.

### 4. Forward cert identity to upstreams (optional)

```nginx
proxy_set_header X-SSL-Client-Verify $ssl_client_verify;
proxy_set_header X-SSL-Client-DN     $ssl_client_s_dn;
```

---

## Layered security model

```
Internet
   │
   ▼
[TLS 1.3 + optional mTLS]     ← ADR-0016, this guide
   │
   ▼
[WAF + backpressure]          ← ADR-0006, ADR-0010
   │
   ▼
[JWT validation]              ← ADR-0005
   │
   ▼
[Rate limit + routing + LB]   ← ADR-0007, ADR-0014, ADR-0009
   │
   ▼
Upstream (private network)
```

---

## Control plane mTLS (operators)

The admin API (`POST /config`) uses **HMAC body signing** (ADR-0023), not mTLS.
For high-assurance environments, add **network policy** so only CI/CD IPs reach
port 8081, or terminate mTLS at an internal ingress in front of the control
plane.

---

## Redis TLS (managed Redis)

```bash
REDIS_HOST=master.xxx.cache.amazonaws.com
REDIS_PORT=6379
REDIS_PASSWORD=...
REDIS_TLS=1    # uses rediss:// (native TLS)
```

Implemented in `redis_url()` — see [ADR-0028](../decisions/0028-redis-authentication-and-isolation.md).

---

## Checklist

- [ ] Real server cert (not self-signed) in production
- [ ] CA bundle mounted for client verification
- [ ] `ssl_verify_client on` or `optional` per audience
- [ ] Partner certs rotated on schedule
- [ ] Control plane on private network + HMAC signing
- [ ] Redis on private network + password/ACL

→ [SECURITY.md](../SECURITY.md) | [PRODUCTION.md](../PRODUCTION.md)
