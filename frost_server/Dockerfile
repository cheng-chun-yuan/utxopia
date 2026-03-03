# FROST Threshold Signing Server
# Multi-stage build for minimal final image

# Stage 1: Build
FROM rust:1.93-slim-bookworm AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy Cargo files for caching
COPY Cargo.toml Cargo.lock ./

# Create dummy src for dependency caching
RUN mkdir -p src/bin && \
    echo "fn main() {}" > src/main.rs && \
    echo "" > src/lib.rs

RUN cargo build --release 2>/dev/null || true

# Copy actual source
COPY src/ src/

# Touch to force rebuild
RUN touch src/main.rs src/lib.rs

# Build release binary
RUN cargo build --release --bin frost-server

# Stage 2: Runtime
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/target/release/frost-server /app/frost-server

# Create directories
RUN mkdir -p /app/config /app/logs

# Non-root user
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

ENV RUST_LOG=info,frost_server=debug

ENTRYPOINT ["/app/frost-server"]
