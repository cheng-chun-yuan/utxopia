# Stage 1: Build the Rust binary
FROM rust:1.84-slim-bookworm AS builder

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

# Create non-root user for security
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

# Environment variables (can be overridden in Railway)
ENV RUST_LOG=info
ENV SOLANA_RPC_URL=https://api.devnet.solana.com
ENV ESPLORA_URL=https://blockstream.info/testnet/api

# Run the redemption service
CMD ["/app/zkbtc-api", "redemption", "--interval", "30"]
