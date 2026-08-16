# ADR-0046 — Docker multi-stage build (slim runtime image)

**Status:** Accepted

## Context

The gateway ships as a Docker image containing OpenResty + a Rust cdylib. The
Rust toolchain is large (~1 GB+) and unnecessary at runtime. Production images
should minimize attack surface and pull time while keeping reproducible builds.

## Decision

**Two-stage Dockerfile** (`gateway/Dockerfile`):

1. **Builder** (`rust:slim-bullseye`) — compiles `librust_ext.so` with release
   profile (LTO, strip per `Cargo.toml`). Uses dependency-layer caching: copy
   `Cargo.toml` + stub `lib.rs`, build, then copy real sources.
2. **Runtime** (`openresty/openresty:1.21.4.1-bullseye`) — copies only the
   `.so`, Lua bridge, NGINX configs. No `rustc`, no source code.

Dev/CI TLS: self-signed cert generated at **image build** for local HTTPS; production
mounts real certs at `/etc/nginx/certs/` ([ADR-0016](0016-tls-termination.md)).

Same pattern for `services/gateway/control-plane/` and `services/gateway/sidecar/` (single-stage Rust
binaries — small enough not to split further).

## Alternatives considered

- **Single-stage (Rust + OpenResty in one image).** Simpler Dockerfile but ~2×
  image size and full compiler toolchain in production — rejected.
- **Distroless runtime.** No official OpenResty distroless; NGINX+LuaJIT needs
  a maintained base — OpenResty image is the pragmatic choice ([ADR-0001](0001-rust-plus-openresty-nginx.md)).
- **Pre-built `.so` in Git LFS.** Reproducibility and arch coupling (amd64 vs
  arm64) — build in CI/Docker instead.
- **Static linking (`musl`).** cdylib + OpenResty dynamic loader expects `.so`;
  static linking fights NGINX FFI load model.

## Consequences

- Production pods run without Rust toolchain — smaller attack surface.
- Build time remains in CI/CD; runtime pulls are faster.
- Operators must rebuild image when `rust-ext` changes (no hot-patch of `.so`
  without sidecar volume mount — not supported).

## Related

- [`../../services/gateway/edge/Dockerfile`](../../services/gateway/edge/Dockerfile)
- [ADR-0001](0001-rust-plus-openresty-nginx.md)
- [ADR-0019](0019-deployment-and-kernel-tuning.md)
