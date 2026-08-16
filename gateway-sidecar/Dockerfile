# ============================================================
# Config Sidecar Dockerfile
# One per gateway node. Pulls config from the control plane over
# HTTP and writes it atomically to a file the gateway watches.
# Stage 1: Rust builder (release, stripped)
# Stage 2: minimal Debian runtime, non-root
# ============================================================

# ── Stage 1: Rust Builder ────────────────────────────────────
FROM rust:slim-bullseye AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY src ./src

ENV RUSTFLAGS="-C opt-level=3 -C codegen-units=1"
RUN cargo build --release && strip target/release/config-sidecar

# ── Stage 2: Runtime ─────────────────────────────────────────
FROM debian:bullseye-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/config-sidecar /usr/local/bin/config-sidecar

# Runs as root so it can write to Docker named volumes (root-owned on create).
# In Kubernetes, prefer an fsGroup on the pod securityContext instead of root.
RUN mkdir -p /etc/gateway && chmod 1777 /etc/gateway

ENTRYPOINT ["/usr/local/bin/config-sidecar"]
