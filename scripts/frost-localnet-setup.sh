#!/bin/bash
# Generate FROST keys for localnet and start signers in Docker
#
# Usage: ./scripts/frost-localnet-setup.sh
#
# Prerequisites:
#   - frost-server binary built: cd frost_server && cargo build --release
#   - Docker running
#
# Output:
#   - Prints the FROST group public key (use in SDK config / localnet-state.json)
#   - Starts 2 FROST signers via docker compose

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Find frost-server binary
FROST_BIN=""
for p in \
  "$PROJECT_ROOT/frost_server/target/release/frost-server" \
  "$PROJECT_ROOT/frost_server/target/debug/frost-server" \
  "$PROJECT_ROOT/target/release/frost-server" \
  "$PROJECT_ROOT/target/debug/frost-server"; do
  if [ -f "$p" ]; then
    FROST_BIN="$p"
    break
  fi
done

if [ -z "$FROST_BIN" ]; then
  echo "ERROR: frost-server binary not found. Build it first:"
  echo "  cd frost_server && cargo build --release"
  exit 1
fi

echo "Using frost-server: $FROST_BIN"

# Generate keys
KEY_DIR="$PROJECT_ROOT/.frost-localnet-keys"
mkdir -p "$KEY_DIR"

if [ -f "$KEY_DIR/group_pubkey.txt" ]; then
  echo "Keys already exist in $KEY_DIR"
  echo "Group pubkey: $(cat "$KEY_DIR/group_pubkey.txt")"
  echo "To regenerate: rm -rf $KEY_DIR && re-run this script"
else
  echo "Generating 2-of-3 FROST keys..."
  "$FROST_BIN" generate-test-keys \
    --password localnet_test \
    --threshold 2 \
    --total 3 \
    --output-dir "$KEY_DIR"
  echo "Group pubkey: $(cat "$KEY_DIR/group_pubkey.txt")"
fi

GROUP_PUBKEY=$(cat "$KEY_DIR/group_pubkey.txt" | tr -d '[:space:]')

# Copy keys into Docker volume location
# Docker compose mounts frost-localnet-keys volume to /app/config
# We need to inject the key files into the running containers
echo ""
echo "Starting Docker containers..."
cd "$PROJECT_ROOT"

# Start esplora first (FROST signers depend on it)
docker compose -f docker-compose.localnet.yml up -d esplora

# Wait for esplora
echo "Waiting for Esplora..."
until curl -sf http://localhost:3002/regtest/api/blocks/tip/height > /dev/null 2>&1; do
  sleep 2
done
echo "Esplora ready"

# Copy key files into containers via docker cp
# First, build the FROST image if needed
docker compose -f docker-compose.localnet.yml build frost-signer-1 frost-signer-2 2>/dev/null || true

# Start signers (they'll fail initially without keys)
docker compose -f docker-compose.localnet.yml up -d frost-signer-1 frost-signer-2

# Wait a moment then copy keys in
sleep 2
docker cp "$KEY_DIR/signer1.key.enc" aegis-frost-1:/app/config/signer1.key.enc || true
docker cp "$KEY_DIR/signer2.key.enc" aegis-frost-2:/app/config/signer2.key.enc || true

# Restart signers to pick up keys
docker compose -f docker-compose.localnet.yml restart frost-signer-1 frost-signer-2

echo ""
echo "Waiting for FROST signers to be healthy..."
for port in 19101 19102; do
  until curl -sf "http://localhost:$port/health" > /dev/null 2>&1; do
    sleep 1
  done
  echo "  Signer on port $port: ready"
done

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║  FROST Localnet Ready                                  ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║  Group pubkey: $GROUP_PUBKEY"
echo "║  Signer 1: http://localhost:19101                      ║"
echo "║  Signer 2: http://localhost:19102                      ║"
echo "║  API Key: localnet_test_key                            ║"
echo "║  Esplora: http://localhost:3002/regtest/api            ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "To use in E2E tests, set in localnet-state.json:"
echo "  \"groupPubKey\": \"$GROUP_PUBKEY\""
echo "  \"signingMode\": \"frost\""
echo "  \"frostSignerUrls\": [\"http://localhost:19101\", \"http://localhost:19102\"]"
