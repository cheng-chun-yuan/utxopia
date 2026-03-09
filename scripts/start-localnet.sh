#!/usr/bin/env bash
# =============================================================================
# Aegis Local Development Stack
#
# Starts:
#   1. Bitcoin regtest (Esplora Docker on port 3002)
#   2. Solana test validator (port 8899) with BN254 pairing support
#   3. Deploy & initialize Solana programs
#   4. Backend API (port 3001) with regtest config
#   5. Frontend dev server (port 3000)
#
# Prerequisites:
#   - Docker running
#   - solana-test-validator installed
#   - Contracts built: cd contracts && cargo build-sbf --features devnet
#   - SDK built: cd sdk && bun run build
#
# Usage:
#   ./scripts/start-localnet.sh          # Start everything
#   ./scripts/start-localnet.sh --no-frontend  # Skip Next.js dev server
#   ./scripts/start-localnet.sh --stop   # Stop all services
# =============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[localnet]${NC} $1"; }
warn() { echo -e "${YELLOW}[localnet]${NC} $1"; }
err()  { echo -e "${RED}[localnet]${NC} $1"; }
info() { echo -e "${BLUE}[localnet]${NC} $1"; }

# ---------------------------------------------------------------------------
# Stop all services
# ---------------------------------------------------------------------------
stop_all() {
  log "Stopping all localnet services..."

  # Stop frontend
  if [ -f /tmp/aegis-frontend.pid ]; then
    kill "$(cat /tmp/aegis-frontend.pid)" 2>/dev/null || true
    rm -f /tmp/aegis-frontend.pid
  fi

  # Stop backend
  if [ -f /tmp/aegis-backend.pid ]; then
    kill "$(cat /tmp/aegis-backend.pid)" 2>/dev/null || true
    rm -f /tmp/aegis-backend.pid
  fi

  # Stop Solana validator
  if [ -f /tmp/aegis-validator.pid ]; then
    kill "$(cat /tmp/aegis-validator.pid)" 2>/dev/null || true
    rm -f /tmp/aegis-validator.pid
  fi

  # Stop Bitcoin regtest Docker
  docker compose -f docker-compose.regtest.yml down 2>/dev/null || true

  log "All services stopped."
  exit 0
}

if [ "${1:-}" = "--stop" ]; then
  stop_all
fi

NO_FRONTEND=false
if [ "${1:-}" = "--no-frontend" ]; then
  NO_FRONTEND=true
fi

# ---------------------------------------------------------------------------
# Step 1: Bitcoin Regtest (Esplora Docker)
# ---------------------------------------------------------------------------
log "Step 1: Starting Bitcoin regtest (Esplora on port 3002)..."

if docker ps --format '{{.Names}}' | grep -q aegis-esplora-regtest; then
  info "Esplora container already running"
else
  docker compose -f docker-compose.regtest.yml up -d
fi

# Wait for Esplora API
ESPLORA_URL="http://localhost:3002/regtest/api"
log "Waiting for Esplora API at $ESPLORA_URL..."
for i in $(seq 1 60); do
  if curl -sf "$ESPLORA_URL/blocks/tip/height" > /dev/null 2>&1; then
    TIP=$(curl -sf "$ESPLORA_URL/blocks/tip/height")
    log "Esplora ready — tip height: $TIP"
    break
  fi
  if [ "$i" -eq 60 ]; then
    err "Esplora did not start within 60 seconds"
    exit 1
  fi
  sleep 2
done

# Create wallet and mine initial blocks if needed
BITCOIN_CLI="docker exec aegis-esplora-regtest /srv/explorer/bitcoin/bin/bitcoin-cli -regtest -datadir=/data/bitcoin"
TIP=$(curl -sf "$ESPLORA_URL/blocks/tip/height" 2>/dev/null || echo "0")
if [ "$TIP" -lt 101 ]; then
  log "Setting up regtest wallet and mining initial blocks..."
  $BITCOIN_CLI createwallet test 2>/dev/null || $BITCOIN_CLI loadwallet test 2>/dev/null || true
  ADDR=$($BITCOIN_CLI -rpcwallet=test getnewaddress '' bech32)
  $BITCOIN_CLI -rpcwallet=test generatetoaddress 101 "$ADDR" > /dev/null
  sleep 5  # Wait for Esplora to index
  TIP=$(curl -sf "$ESPLORA_URL/blocks/tip/height")
  log "Mined 101 blocks — tip height: $TIP"
fi

# Get regtest tip for light client init
REGTEST_TIP_HEIGHT=$(curl -sf "$ESPLORA_URL/blocks/tip/height")
REGTEST_TIP_HASH=$(curl -sf "$ESPLORA_URL/blocks/tip/hash")
log "Regtest tip: height=$REGTEST_TIP_HEIGHT hash=${REGTEST_TIP_HASH:0:16}..."

# ---------------------------------------------------------------------------
# Step 2: Solana Test Validator
# ---------------------------------------------------------------------------
log "Step 2: Starting Solana test validator..."

if curl -sf http://127.0.0.1:8899 -X POST -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' > /dev/null 2>&1; then
  info "Solana validator already running"
else
  log "Starting solana-test-validator with BN254 pairing support..."
  solana-test-validator \
    --clone-feature-set --url devnet \
    --reset \
    --quiet \
    &
  echo $! > /tmp/aegis-validator.pid

  # Wait for validator
  for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:8899 -X POST -H "Content-Type: application/json" \
         -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' > /dev/null 2>&1; then
      log "Solana validator ready"
      break
    fi
    if [ "$i" -eq 30 ]; then
      err "Solana validator did not start within 30 seconds"
      exit 1
    fi
    sleep 1
  done
fi

# Ensure default keypair has SOL
solana config set --url http://127.0.0.1:8899 > /dev/null 2>&1
BALANCE=$(solana balance 2>/dev/null | awk '{print $1}' || echo "0")
if [ "$(echo "$BALANCE < 1" | bc 2>/dev/null || echo 1)" -eq 1 ]; then
  solana airdrop 10 > /dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# Step 3: Deploy & Initialize Solana Programs
# ---------------------------------------------------------------------------
log "Step 3: Deploying Solana programs..."

# Check if programs are built
if [ ! -f contracts/target/deploy/aegis_pinocchio.so ]; then
  err "Programs not built. Run: cd contracts && cargo build-sbf --features devnet"
  exit 1
fi

cd contracts
BTC_NETWORK=regtest \
BTC_START_HEIGHT="$REGTEST_TIP_HEIGHT" \
BTC_START_HASH="$REGTEST_TIP_HASH" \
  bun run scripts/deploy-localnet.ts 2>&1 | while IFS= read -r line; do echo "  $line"; done
cd "$PROJECT_ROOT"

# Read back the deployed program IDs from .localnet-config.json
if [ -f contracts/.localnet-config.json ]; then
  AEGIS_PROGRAM_ID=$(python3 -c "import json; print(json.load(open('contracts/.localnet-config.json'))['programs']['Aegis'])" 2>/dev/null || echo "")
  BTC_LC_PROGRAM_ID=$(python3 -c "import json; print(json.load(open('contracts/.localnet-config.json'))['programs']['btcLightClient'])" 2>/dev/null || echo "")
  POOL_STATE=$(python3 -c "import json; print(json.load(open('contracts/.localnet-config.json'))['accounts']['poolState'])" 2>/dev/null || echo "")
  COMMITMENT_TREE=$(python3 -c "import json; print(json.load(open('contracts/.localnet-config.json'))['accounts']['commitmentTree'])" 2>/dev/null || echo "")
  ZKBTC_MINT=$(python3 -c "import json; print(json.load(open('contracts/.localnet-config.json'))['accounts']['zkbtcMint'])" 2>/dev/null || echo "")
  CHADBUFFER_ID=$(python3 -c "import json; print(json.load(open('contracts/.localnet-config.json'))['programs']['chadbuffer'])" 2>/dev/null || echo "")
  GROTH16_ID=$(python3 -c "import json; print(json.load(open('contracts/.localnet-config.json'))['programs']['groth16Verifier'])" 2>/dev/null || echo "")

  log "Deployed programs:"
  info "  Aegis:          $AEGIS_PROGRAM_ID"
  info "  BTC Light Client: $BTC_LC_PROGRAM_ID"
  info "  Pool State:     $POOL_STATE"
  info "  Commitment Tree: $COMMITMENT_TREE"
  info "  zkBTC Mint:     $ZKBTC_MINT"
fi

# ---------------------------------------------------------------------------
# Step 4: Generate .env files for local services
# ---------------------------------------------------------------------------
log "Step 4: Writing .env.localnet files..."

# Get default keypair as JSON array for relayer/admin
KEYPAIR_PATH="$HOME/.config/solana/id.json"
if [ -f "$KEYPAIR_PATH" ]; then
  KEYPAIR_JSON=$(cat "$KEYPAIR_PATH")
else
  warn "No Solana keypair found at $KEYPAIR_PATH"
  KEYPAIR_JSON="[]"
fi

# Frontend .env.localnet
cat > aegis-app/.env.localnet << EOF
# Aegis Frontend — Localnet Configuration (auto-generated)
NEXT_PUBLIC_NETWORK=localnet
NEXT_PUBLIC_SOLANA_RPC_URL=http://127.0.0.1:8899
NEXT_PUBLIC_ZKBTC_API_URL=http://localhost:3001
NEXT_PUBLIC_CIRCUIT_CDN_URL=/circuits
NEXT_PUBLIC_BTC_LIGHT_CLIENT_PROGRAM_ID=${BTC_LC_PROGRAM_ID:-}
ADMIN_KEYPAIR=${KEYPAIR_JSON}
RELAYER_KEYPAIR=${KEYPAIR_JSON}
BACKEND_API_KEY=localnet-dev-key
EOF
info "  Written: aegis-app/.env.localnet"

# Backend .env.localnet
cat > backend/.env.localnet << EOF
# Aegis Backend — Localnet/Regtest Configuration (auto-generated)
AEGIS_NETWORK=regtest
AEGIS_SOLANA_RPC=http://127.0.0.1:8899
AEGIS_BITCOIN_RPC=http://localhost:3002/regtest/api
AEGIS_PROGRAM_ID=${AEGIS_PROGRAM_ID:-}
AEGIS_POOL_STATE=${POOL_STATE:-}
AEGIS_COMMITMENT_TREE=${COMMITMENT_TREE:-}
AEGIS_ZKBTC_MINT=${ZKBTC_MINT:-}
AEGIS_SIGNING_MODE=single
AEGIS_DEMO_MODE=1
AEGIS_LOG_LEVEL=debug
RUST_LOG=info,zkbtc=debug
ALLOWED_ORIGIN=http://localhost:3000
BACKEND_API_KEY=localnet-dev-key
ESPLORA_URL=http://localhost:3002/regtest/api
SOLANA_RPC_URL=http://127.0.0.1:8899
DEPOSIT_DB_PATH=./data/deposits.db
INDEXER_DB_PATH=./data/events.db
TRACKER_API_PORT=3001
POOL_RECEIVE_ADDRESS=
BTC_LIGHT_CLIENT_PROGRAM_ID=${BTC_LC_PROGRAM_ID:-}
SERVICE_FEE_SATS=500
RELAYER_FEE_SATS=500
EOF
info "  Written: backend/.env.localnet"

# ---------------------------------------------------------------------------
# Step 5: Start Backend
# ---------------------------------------------------------------------------
log "Step 5: Starting backend (port 3001)..."

cd backend
mkdir -p data

if [ -f /tmp/aegis-backend.pid ] && kill -0 "$(cat /tmp/aegis-backend.pid)" 2>/dev/null; then
  info "Backend already running"
else
  # Source the env file and start backend
  set -a
  source .env.localnet
  set +a
  cargo run -- tracker --interval 30 --confirmations 1 &
  echo $! > /tmp/aegis-backend.pid
  log "Backend started (PID $(cat /tmp/aegis-backend.pid))"
fi
cd "$PROJECT_ROOT"

# ---------------------------------------------------------------------------
# Step 6: Start Frontend (optional)
# ---------------------------------------------------------------------------
if [ "$NO_FRONTEND" = false ]; then
  log "Step 6: Starting frontend (port 3000)..."

  cd aegis-app
  # Copy localnet env as active env
  cp .env.localnet .env.local

  bun run dev &
  echo $! > /tmp/aegis-frontend.pid
  log "Frontend started (PID $(cat /tmp/aegis-frontend.pid))"
  cd "$PROJECT_ROOT"
else
  info "Skipping frontend (--no-frontend flag)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  Aegis Localnet Stack Running"
echo "============================================================"
echo ""
echo "  Bitcoin Regtest (Esplora):  http://localhost:3002"
echo "    REST API:                 http://localhost:3002/regtest/api"
echo "    Tip height:               $REGTEST_TIP_HEIGHT"
echo ""
echo "  Solana Validator:           http://127.0.0.1:8899"
echo "    Aegis Program:            ${AEGIS_PROGRAM_ID:-unknown}"
echo "    BTC Light Client:         ${BTC_LC_PROGRAM_ID:-unknown}"
echo ""
echo "  Backend API:                http://localhost:3001"
echo "  Frontend:                   http://localhost:3000"
echo ""
echo "  Useful commands:"
echo "    Mine a block:   docker exec aegis-esplora-regtest /srv/explorer/bitcoin/bin/bitcoin-cli -regtest -datadir=/data/bitcoin -rpcwallet=test generatetoaddress 1 \$(docker exec aegis-esplora-regtest /srv/explorer/bitcoin/bin/bitcoin-cli -regtest -datadir=/data/bitcoin -rpcwallet=test getnewaddress)"
echo "    Stop all:       ./scripts/start-localnet.sh --stop"
echo ""
echo "============================================================"
echo ""

# Keep script running (wait for background processes)
wait
