# Kubernetes deployment

Reference manifests for running the gateway on Kubernetes.

## Layout

```
platform/deploy/kubernetes/
└── gateway.yaml   # Namespace, Secret, ConfigMap, gateway+sidecar Deployment, control-plane
```

## Sidecar pattern

Each gateway pod runs **two containers**:

1. **gateway** — OpenResty + Rust FFI (data plane)
2. **config-sidecar** — polls control plane, writes `/etc/gateway/config.json`

They share an `emptyDir` volume. This matches the Docker Compose model and
ADR-0012 (one HTTP poll per pod, not per worker).

## Apply

```bash
# 1. Edit JWT_SECRET and ADMIN_API_KEY in gateway.yaml Secret section
# 2. Build and push images to your registry, update image: tags
kubectl apply -f platform/deploy/kubernetes/gateway.yaml
```

## Notes

- Set `GATEWAY_REGION` per PoP in the ConfigMap (`EU` / `US` / `AP`).
- Mount real TLS certs via a Secret volume on the gateway container.
- For production, run Redis separately and set `REDIS_HOST` in the ConfigMap.
- Use `fsGroup` on the pod securityContext so the sidecar can write the shared volume.

See [docs/PRODUCTION.md](../../docs/PRODUCTION.md) and
[docs/decisions/0012-config-distribution-sidecar-file-watch.md](../../docs/decisions/0012-config-distribution-sidecar-file-watch.md).

## Network segmentation (production)

Apply reference NetworkPolicies after the main manifest:

```bash
kubectl apply -f platform/deploy/kubernetes/network-policy.yaml
```

Adapt namespace labels for your ingress controller and monitoring stack.
See [ADR-0044](../../docs/decisions/0044-kubernetes-network-segmentation.md).
