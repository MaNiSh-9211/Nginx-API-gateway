# ADR-0016 — TLS termination strategy

**Status:** Accepted

## Context

The gateway is the TLS edge for clients. TLS handshakes are the most expensive
part of connection setup, and misconfigured TLS is a common, serious
vulnerability. We need modern, fast, safe TLS with a clean path to real certs in
production.

## Decision

Terminate TLS at the gateway in NGINX with a hardened profile:

- **TLS 1.2 + 1.3 only**, a modern ECDHE/AEAD cipher suite, `secp384r1` curve,
  `server_tokens off`.
- **Handshake cost reduction**: shared TLS **session cache** (resumption) and
  **OCSP stapling** (no client round-trip to the CA). Tickets are disabled in
  favor of the session cache for forward-secrecy hygiene.
- **Slowloris/slow-read defenses**: short header/body timeouts, keepalive caps,
  `reset_timedout_connection`.
- **HTTP/2** on the TLS listener.
- **mTLS** is available (commented `ssl_verify_client`) for zero-trust upstream/
  partner scenarios.
- **Certs**: a self-signed cert is generated at image build for dev/CI; in
  production, **mount real certs** at `/etc/nginx/certs/server.{crt,key}` from a
  secret manager / ACM / cert-manager (no private keys baked into images).
- Security headers (HSTS, CSP, `X-Content-Type-Options`, frame/referrer/
  permissions policies) are added on responses.

## Alternatives considered

- **TLS passthrough to upstreams (L4).** Pushes TLS work and cert management to
  every backend and blinds the gateway to L7 (no WAF/auth/routing on encrypted
  bytes). Rejected — L7 features require termination here.
- **Terminate at an external LB (ALB/NLB) only.** Common and fine; we still
  support TLS at the gateway so it is self-contained and so mTLS/HTTP-2 behavior
  is under our control. The two compose (LB in front, gateway re-terminates or
  trusts via `set_real_ip_from`).
- **Bake certs into the image.** Simple but leaks private keys into the image
  registry and couples rotation to rebuilds. Rejected for production (dev only).

## Consequences

- A modern, fast, hardened TLS edge with cheap resumption and stapling.
- Clean separation of dev (self-signed) vs prod (mounted) certs.
- Cost: certificate lifecycle (issuance/rotation) is an external responsibility;
  document the mount + reload procedure for your platform.
