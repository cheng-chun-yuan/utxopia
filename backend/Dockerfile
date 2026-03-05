# Stage 1: Build the Rust binary
FROM rust:1.93-slim-bookworm AS builder

WORKDIR /app

# Install dependencies needed for building
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy Cargo files for dependency caching
COPY Cargo.toml Cargo.lock* ./

# Create a dummy src to build dependencies first (for caching)
RUN mkdir -p src/bin && \
    echo "fn main() {}" > src/main.rs && \
    echo "fn main() {}" > src/bin/redemption.rs && \
    echo "" > src/lib.rs

# Build dependencies only (will be cached if Cargo.toml doesn't change)
RUN cargo build --release 2>/dev/null || true

# Now copy actual source code
COPY src ./src

# Touch files to ensure rebuild
RUN touch src/main.rs src/lib.rs src/bin/redemption.rs

# Build the actual binary
RUN cargo build --release --bin zkbtc-api

# Stage 2: Create minimal runtime image
FROM debian:bookworm-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Copy the binary from builder
COPY --from=builder /app/target/release/zkbtc-api /app/zkbtc-api

# Create data directory and non-root user
RUN mkdir -p /app/data && \
    useradd -m -u 1000 appuser && chown -R appuser:appuser /app

# Entrypoint: fix data dir ownership (handles host-created files), then run as appuser
RUN printf '#!/bin/sh\nchown -R appuser:appuser /app/data 2>/dev/null || true\nexec gosu appuser "$@"\n' > /app/entrypoint.sh && \
    chmod +x /app/entrypoint.sh && \
    apt-get update && apt-get install -y gosu && rm -rf /var/lib/apt/lists/*

ENV RUST_LOG=info

EXPOSE 3001

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["/app/zkbtc-api", "api", "--port", "3001"]
