# Stage 1: Build the Rust binary
FROM rust:1.88-slim-bookworm AS builder

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

# Cache buster
ARG CACHEBUST=1

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
    docker.io \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Copy the binary from builder
COPY --from=builder /app/target/release/zkbtc-api /app/zkbtc-api

# Create data directory and non-root user
RUN mkdir -p /app/data && \
    useradd -m -u 1000 appuser && chown -R appuser:appuser /app

ENV RUST_LOG=info

EXPOSE 3001

USER appuser

CMD ["/app/zkbtc-api", "tracker", "--interval", "60", "--confirmations", "1"]
