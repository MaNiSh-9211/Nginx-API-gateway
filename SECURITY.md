# Security Policy

## Reporting vulnerabilities

If you discover a security issue in this gateway, **do not open a public GitHub
issue** with exploit details.

Contact the maintainers privately with:

- Description and impact
- Steps to reproduce
- Affected version / commit

We aim to acknowledge reports within **5 business days**.

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest release (`main` / tagged `v*`) | Yes |
| Older tags | Best effort |

## Security model documentation

Full threat matrix, controls, and JWT/revocation contracts:

- [docs/SECURITY.md](docs/SECURITY.md)
- Architecture Decision Records: [docs/decisions/README.md](docs/decisions/README.md)

## Production hardening checklist

Before exposing this gateway to the internet:

1. Rotate `JWT_SECRET` and `ADMIN_API_KEY` — [ADR-0013](docs/decisions/0013-secrets-via-environment-not-config-wire.md)
2. Set `GATEWAY_REFUSE_INSECURE_SECRETS=1` — [ADR-0041](docs/decisions/0041-refuse-insecure-secrets-at-startup.md)
3. Mount real TLS certificates — [ADR-0016](docs/decisions/0016-tls-termination.md)
4. Restrict control plane and `/metrics` to private network — [ADR-0023](docs/decisions/0023-admin-api-hmac-authentication.md)
5. Apply Kubernetes NetworkPolicies — [ADR-0044](docs/decisions/0044-kubernetes-network-segmentation.md)

See [docs/RELEASE.md](docs/RELEASE.md) for the full release gate.
