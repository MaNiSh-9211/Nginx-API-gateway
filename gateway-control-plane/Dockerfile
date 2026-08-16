# ============================================================
# Control Plane Dockerfile — Ultra-Scale API Gateway
# Stage 1: Rust builder (release, stripped)
# Stage 2: Minimal Debian runtime
# ============================================================

# ── Stage 1: Rust Builder ────────────────────────────────────
FROM rust:slim-bullseye AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/control-plane
COPY Cargo.toml Cargo.lock ./
COPY src ./src

# Release profile in Cargo.toml already sets LTO; do not duplicate in RUSTFLAGS
# (Docker's rustc rejects `-C lto` combined with `-C embed-bitcode=no`).
ENV RUSTFLAGS="-C opt-level=3 -C codegen-units=1"
RUN cargo build --release

RUN strip target/release/control-plane

# ── Stage 2: Minimal Runtime ─────────────────────────────────
FROM debian:bullseye-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl1.1 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for security. Pinned to uid/gid 1000 so it matches the
# Kubernetes securityContext runAsUser (ADR-0051) for a consistent, verifiable
# non-root identity across Docker and K8s.
RUN useradd -u 1000 -r -s /bin/false gateway

COPY --from=builder /usr/src/control-plane/target/release/control-plane \
     /usr/local/bin/control-plane

COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY conf.d/initial-snapshot.template.json /app/conf.d/initial-snapshot.template.json

# Config directory — entrypoint writes initial-snapshot.json at startup
RUN mkdir -p /app/conf.d \
    && sed -i 's/\r$//' /docker-entrypoint.sh \
    && chmod +x /docker-entrypoint.sh \
    && chown -R gateway:gateway /app

USER gateway
WORKDIR /app

EXPOSE 8081

ENTRYPOINT ["/docker-entrypoint.sh"]
