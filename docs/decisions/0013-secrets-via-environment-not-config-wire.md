# ADR-0013 — Secrets via environment, never the config wire

**Status:** Accepted

## Context

The gateway needs the JWT signing secret to verify tokens (ADR-0005). Config is
distributed through the control plane's HTTP API and cached in a file on disk
(ADR-0012). If the secret travelled that path, it would be exposed in API
responses, on disk, in logs, and in config history — a large blast radius.

## Decision

**Secrets are sourced from the environment / a secret manager, not distributed
through the config API.**

- The control plane **strips `jwt_secret` and `jwt_keys`** from `GET /config`
  responses (`skip_serializing`), so the sidecar never receives them and they
  never hit the gateway's config file.
- The gateway loads `JWT_SECRET` from its **own environment** and injects it into
  the in-memory config after deserializing the distributed snapshot
  (`apply_secret_overrides` in `config.rs`). `jwt_secret` carries a serde default
  so the secret-less distributed config still deserializes cleanly.
- Non-secret policy that *should* be distributed (e.g. `expected_issuer`,
  `expected_audience`) **is** served via the config API.
- `ADMIN_API_KEY` (for signed config pushes, ADR-0011) and the Grafana password
  are likewise environment-provided placeholders to be replaced by a real secret
  store.
- Secret env vars must come from a Kubernetes **`Secret`**, never a `ConfigMap`.
  ConfigMaps are stored in plaintext (no encryption-at-rest) and are visible via
  `kubectl get cm -o yaml`. The Helm chart therefore renders `JWT_SECRET`,
  `ADMIN_API_KEY`, and (when set) `REDIS_PASSWORD` into `gateway-secrets` and
  injects them with `secretKeyRef`; only non-secret Redis fields (`host`, `port`,
  `username`, `tls`) live in the ConfigMap.

## Alternatives considered

- **Distribute the secret in the config snapshot.** Simplest wiring, but leaks
  the secret to the API, disk, and history. Rejected outright.
- **Encrypt the secret inside the config (sealed/SOPS).** Better, and compatible
  with GitOps, but still puts ciphertext on the wire/disk and needs a decrypt key
  delivered out-of-band anyway — so the env/secret-manager path is the
  out-of-band channel, kept minimal.
- **Fetch the secret from a vault at startup.** Excellent for production; the env
  variable is the integration point a vault agent / CSI driver populates.

## Consequences

- The secret's blast radius is the environment of the gateway process only.
- Clear separation: control plane owns *policy*; the platform owns *secrets*.
- Cost: operators must keep `JWT_SECRET` identical across the gateway and the
  token issuer (documented in `.env`), and the gateway will reject all tokens if
  the secret is wrong — a loud, safe failure mode.
