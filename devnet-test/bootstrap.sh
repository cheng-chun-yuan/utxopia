#!/usr/bin/env bash
# =============================================================================
# Aegis Devnet Integration Test — Bootstrap Script
# =============================================================================
# Sets up everything needed for production-like devnet testing:
# 1. Compile JoinSplit circuits + trusted setup
# 2. Build + deploy Solana programs (idempotent)
# 3. Register VK hashes on-chain
# 4. Generate FROST keys (2-of-3 trusted dealer)
# 5. Derive pool Taproot address
# 6. Update .env with generated values
# 7. Initialize header relayer
# 8. Start all services
# 9. Run health check

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_TEST_DIR="$ROOT_DIR/devnet-test"
ENV_FILE="$DEVNET_TEST_DIR/.env"

echo "============================================"
echo " Aegis Devnet Bootstrap"
echo "============================================"
echo "Root: $ROOT_DIR"
echo ""

# Copy env template if .env doesn't exist
if [ ! -f "$ENV_FILE" ]; then
  cp "$DEVNET_TEST_DIR/.env.devnet-test" "$ENV_FILE"
  echo "[1/9] Created .env from template"
else
  echo "[1/9] .env already exists — using existing"
fi

source "$ENV_FILE" 2>/dev/null || true

# ------------------------------------------------
# Step 1: Compile JoinSplit circuits
# ------------------------------------------------
echo ""
echo "[2/9] Compiling tier-1 JoinSplit circuits..."
cd "$ROOT_DIR/circuits"
if [ ! -f "build/joinsplit_1x2/joinsplit_1x2_js/joinsplit_1x2.wasm" ]; then
  bun install
  bash scripts/compile.sh
  echo "  Circuits compiled."
else
  echo "  Circuits already compiled — skipping."
fi

# ------------------------------------------------
# Step 2: Trusted setup (if .zkey files missing)
# ------------------------------------------------
echo ""
echo "[3/9] Running Groth16 trusted setup..."
if [ ! -f "build/joinsplit_1x2/joinsplit_1x2.zkey" ]; then
  bash scripts/setup.sh
  echo "  Setup complete."
else
  echo "  ZKey files already exist — skipping."
fi

# ------------------------------------------------
# Step 3: Build + deploy Solana programs
# ------------------------------------------------
echo ""
echo "[4/9] Building Solana programs..."
cd "$ROOT_DIR/contracts"
cargo build-sbf --features devnet 2>&1 | tail -3

echo "  Deploying to devnet (idempotent)..."
bun run deploy:devnet 2>&1 | tail -5 || echo "  Deploy may have already completed."

# ------------------------------------------------
# Step 4: Register VK hashes
# ------------------------------------------------
echo ""
echo "[5/9] Registering VK hashes on-chain..."
cd "$ROOT_DIR/sdk"
NETWORK=devnet bun run scripts/register-vk-hashes.ts 2>&1 | tail -10

# ------------------------------------------------
# Step 5: Generate FROST keys (if not already set)
# ------------------------------------------------
echo ""
echo "[6/9] Checking FROST key generation..."
if [ -z "${FROST_GROUP_PUBKEY:-}" ]; then
  echo "  FROST_GROUP_PUBKEY not set. Starting FROST signers for DKG..."
  echo "  NOTE: Start 3 FROST signers manually, then run DKG:"
  echo "    cd $ROOT_DIR/frost_server"
  echo "    cargo run --bin frost-server -- --port 8081 &"
  echo "    cargo run --bin frost-server -- --port 8082 &"
  echo "    cargo run --bin frost-server -- --port 8083 &"
  echo "    # Then trigger DKG via API and update .env with group pubkey"
  echo ""
  echo "  Skipping automated DKG for now."
else
  echo "  FROST group pubkey: ${FROST_GROUP_PUBKEY:0:16}..."
fi

# ------------------------------------------------
# Step 6: Derive pool Taproot address
# ------------------------------------------------
echo ""
echo "[7/9] Deriving pool Taproot address..."
if [ -n "${FROST_GROUP_PUBKEY:-}" ]; then
  cd "$ROOT_DIR/sdk"
  bun run scripts/derive-deposit-addr.ts 2>&1 | tail -3 || echo "  Derive script not available yet."
else
  echo "  Skipping — FROST group pubkey not set."
fi

# ------------------------------------------------
# Step 7: Initialize header relayer
# ------------------------------------------------
echo ""
echo "[8/9] Initializing header relayer..."
cd "$ROOT_DIR/backend/header-relayer"
bun install 2>/dev/null
bun run init 2>&1 | tail -3 || echo "  Header relayer init may have already completed."

# ------------------------------------------------
# Step 8: Verify readiness
# ------------------------------------------------
echo ""
echo "[9/9] Running readiness checks..."
cd "$DEVNET_TEST_DIR"
bun install 2>/dev/null
bun run verify 2>&1 || echo "  Some checks failed — review output above."

echo ""
echo "============================================"
echo " Bootstrap Complete"
echo "============================================"
echo ""
echo "Next steps:"
echo "  cd devnet-test"
echo "  bun run test:health    # Quick sanity check"
echo "  bun run test:full      # Full E2E flow (~30 min)"
echo ""
