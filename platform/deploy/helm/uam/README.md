# UAM Helm chart

Deploy User Access Management as a **separate release** from `api-gateway`.

## Prerequisites

- Kubernetes cluster
- `api-gateway` release running (gateway + control-plane + Redis)
- Container images pushed to your registry (`uam-backend`, `uam-frontend`)

## Install

```bash
helm install uam ./platform/deploy/helm/uam \
  --namespace uam \
  --create-namespace \
  --set secrets.jwtAccessSecret="$(kubectl get secret gateway-secrets -n api-gateway -o jsonpath='{.data.JWT_SECRET}' | base64 -d)" \
  --set secrets.adminApiKey="$(kubectl get secret gateway-secrets -n api-gateway -o jsonpath='{.data.ADMIN_API_KEY}' | base64 -d)" \
  --set secrets.jwtRefreshSecret="CHANGE_ME" \
  --set secrets.passwordPepper="CHANGE_ME" \
  --set secrets.dbPassword="CHANGE_ME" \
  --set clientUrl=https://auth.example.com \
  --set frontend.gatewayProxyUrl=http://gateway.api-gateway.svc.cluster.local:8080
```

## Gateway route

Ensure control-plane config includes:

```json
{ "path_prefix": "/api/auth/", "service_name": "uam-auth", "strip_prefix": false }
```

with `uam-auth` upstream `uam-backend.uam.svc.cluster.local:8080`.

## Values

| Key | Purpose |
|-----|---------|
| `secrets.jwtAccessSecret` | Must equal gateway `JWT_SECRET` (ADR-0050) |
| `auth.omitRefreshInBody` | HttpOnly cookie mode — no refresh in JSON (ADR-0055) |
| `auth.cookieSecure` | `true` behind TLS |
| `mongodb.enabled` | In-cluster External PostgreSQL |

See [ADR-0056](../../../docs/decisions/0056-uam-helm-chart.md).
