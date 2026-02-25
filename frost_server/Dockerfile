# FROST Threshold Signing Server
# Multi-stage build for minimal final image

# Stage 1: Build
FROM rust:1.84-bookworm AS builder

WORKDIR /app

# Copy workspace Cargo files for caching
COPY Cargo.toml Cargo.lock ./

# Copy source
COPY src/ src/
COPY tests/ tests/

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

# Create logs directory
RUN mkdir -p /app/logs

# Default port
EXPOSE 8080

# Environment variables
ENV RUST_LOG=info
ENV FROST_PORT=8080

ENTRYPOINT ["/app/frost-server"]
CMD ["--port", "8080"]
