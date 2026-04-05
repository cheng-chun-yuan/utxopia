#!/usr/bin/env bash
# =============================================================================
# Privacy Coin Unified Setup
#
# One command to set up any environment:
#   ./scripts/setup.sh localnet    — Full local stack + mock data
#   ./scripts/setup.sh devnet      — Configure for devnet
#   ./scripts/setup.sh mainnet     — Configure for mainnet (read-only)
#   ./scripts/setup.sh localnet --stop  — Stop all local services
#
# Localnet starts:
#   1. Bitcoin regtest (Esplora Docker on port 3002)
#   2. Surfpool simnet (port 8899) with BN254 (enabled by default)
#   3. Deploy & init programs + register tokens
#   4. Seed mock data (demo deposits + real BTC deposit)
#   5. Backend API (port 3001)
#   6. Frontend dev server (port 3000)
#
# Prerequisites:
#   - bun installed
#   - Docker running (localnet only)
#   - surfpool installed (localnet only): curl -sL https://run.surfpool.run/ | bash
#   - Contracts built: cd contracts && cargo build-sbf --features devnet
# =============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[setup]${NC} $1"; }
err()  { echo -e "${RED}[setup]${NC} $1" >&2; }
info() { echo -e "${BLUE}[setup]${NC} $1"; }
step() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

NETWORK="${1:-devnet}"
FLAG="${2:-}"

# =============================================================================
# STOP
# =============================================================================
stop_all() {
  log "Stopping all services..."
  for pidfile in /tmp/privacy-coin-frontend.pid /tmp/privacy-coin-backend.pid /tmp/privacy-coin-validator.pid; do
    if [ -f "$pidfile" ]; then
      kill "$(cat "$pidfile")" 2>/dev/null || true
      rm -f "$pidfile"
    fi
  done
  pkill -f "surfpool" 2>/dev/null || true
  pkill -f "solana-test-validator" 2>/dev/null || true
  pkill -f "next dev" 2>/dev/null || true
  docker compose -f docker-compose.regtest.yml down 2>/dev/null || true
  log "All services stopped."
  exit 0
}

[ "$FLAG" = "--stop" ] && stop_all

# =============================================================================
# DEVNET
# =============================================================================
setup_devnet() {
  step "Configuring for Solana Devnet + Bitcoin Testnet4"

  cat > web/.env.local << 'EOF'
# Privacy Coin Frontend — Devnet Configuration
NEXT_PUBLIC_NETWORK=devnet
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_BTC_NETWORK=testnet4
NEXT_PUBLIC_PRIVACY_COIN_PROGRAM_ID=8fqRet9WB5PECvKfWmzTPSusJgQz1onzxTLfHD75XKim
TRACKER_API_URL=https://api-aegis.amidoggy.xyz
BACKEND_URL=https://api-aegis.amidoggy.xyz
BACKEND_API_KEY=privacy-coin-backend-2026
EOF

  log "Written: web/.env.local"
  log ""
  log "Devnet configured. Run: cd web && bun run dev"
  log "Programs already deployed at:"
  info "  Aegis:       8fqRet9WB5PECvKfWmzTPSusJgQz1onzxTLfHD75XKim"
  info "  BTC LC:      Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq"
  info "  Backend API: https://api-aegis.amidoggy.xyz"
}

# =============================================================================
# MAINNET
# =============================================================================
setup_mainnet() {
  step "Configuring for Solana Mainnet + Bitcoin Mainnet"
  warn "Mainnet is READ-ONLY — programs not yet deployed"

  cat > web/.env.local << 'EOF'
# Privacy Coin Frontend — Mainnet Configuration (read-only)
NEXT_PUBLIC_NETWORK=mainnet
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
NEXT_PUBLIC_BTC_NETWORK=mainnet
# NEXT_PUBLIC_PRIVACY_COIN_PROGRAM_ID=  # Not deployed yet
# TRACKER_API_URL=               # Not deployed yet
EOF

  log "Written: web/.env.local"
  warn "Mainnet programs not deployed. Frontend will run in read-only mode."
}

# =============================================================================
# LOCALNET
# =============================================================================
setup_localnet() {
  NO_FRONTEND=false
  SEED_ONLY=false
  [ "$FLAG" = "--no-frontend" ] && NO_FRONTEND=true
  [ "$FLAG" = "--seed-only" ] && SEED_ONLY=true

  if [ "$SEED_ONLY" = true ]; then
    seed_mock_data
    return
  fi

  # --- Step 1: Check prerequisites ---
  step "Step 1: Prerequisites"
  command -v surfpool >/dev/null 2>&1 || { err "surfpool not found. Install: curl -sL https://run.surfpool.run/ | bash"; exit 1; }
  command -v docker >/dev/null 2>&1 || { err "Docker not found"; exit 1; }
  command -v bun >/dev/null 2>&1 || { err "bun not found"; exit 1; }

  PRIVACY_COIN_SO="contracts/target/deploy/privacy_coin.so"
  BTC_LC_SO="contracts/target/deploy/btc_light_client.so"
  if [ ! -f "$PRIVACY_COIN_SO" ]; then
    err "Privacy Coin program not built. Run: cd contracts && cargo build-sbf --features devnet"
    exit 1
  fi
  if [ ! -f "$BTC_LC_SO" ]; then
    err "BTC light client not built. Run: cd contracts && cargo build-sbf --features devnet"
    exit 1
  fi
  log "Prerequisites OK"

  # --- Step 2: Run Full E2E Suite ---
  # The e2e suite handles EVERYTHING:
  #   - Starts Bitcoin regtest Docker (Esplora)
  #   - Starts Solana test validator with programs + NATIVE_MINT_2022
  #   - Initializes pool + registers all tokens (zkBTC, tUSDC, tWSOL)
  #   - Real BTC deposit via SPV verification
  #   - Shield tUSDC + tWSOL into commitments
  #   - JoinSplit transfer with Groth16 proof
  #   - Unshield tUSDC back to SPL
  #   - BTC withdrawal request
  # The e2e suite handles: deploy programs, init pool, register tokens,
  # real BTC deposit, shield SPL, JoinSplit transfer, unshield, BTC withdrawal
  seed_mock_data

  # --- Step 5: Generate .env.local ---
  step "Step 5: Write .env.local"

  # Read mints from e2e state (set by seed_mock_data)
  if [ -f scripts/e2e/localnet-state.json ]; then
    [ -z "$ZKBTC_MINT" ] && ZKBTC_MINT=$(node -e "console.log(require('./scripts/e2e/localnet-state.json').zkbtcMint)" 2>/dev/null)
    USDC_MINT=$(node -e "console.log(require('./scripts/e2e/localnet-state.json').tUsdcMint || '')" 2>/dev/null)
    WSOL_MINT=$(node -e "console.log(require('./scripts/e2e/localnet-state.json').tWsolMint || '')" 2>/dev/null)
  fi

  cat > web/.env.local << EOF
# Privacy Coin Frontend — Localnet (auto-generated by setup.sh)
NEXT_PUBLIC_NETWORK=localnet
NEXT_PUBLIC_SOLANA_RPC_URL=http://localhost:8899
NEXT_PUBLIC_BTC_NETWORK=regtest
NEXT_PUBLIC_PRIVACY_COIN_PROGRAM_ID=8fqRet9WB5PECvKfWmzTPSusJgQz1onzxTLfHD75XKim
NEXT_PUBLIC_ZKBTC_MINT=${ZKBTC_MINT:-}
NEXT_PUBLIC_USDC_MINT=${USDC_MINT:-}
NEXT_PUBLIC_WSOL_MINT=${WSOL_MINT:-}
TRACKER_API_URL=http://localhost:3001
BACKEND_URL=http://localhost:3001
BACKEND_API_KEY=localnet-dev-key
ADMIN_KEYPAIR=$(cat ~/.config/solana/id.json 2>/dev/null || echo "[]")
RELAYER_KEYPAIR=$(cat ~/.config/solana/id.json 2>/dev/null || echo "[]")
EOF
  log "Written: web/.env.local (zkBTC: ${ZKBTC_MINT:-?}, USDC: ${USDC_MINT:-?}, wSOL: ${WSOL_MINT:-?})"

  # --- Step 7: Start Frontend ---
  if [ "$NO_FRONTEND" = false ]; then
    step "Step 7: Frontend"
    cd web
    pkill -f "next dev" 2>/dev/null || true
    sleep 1
    bun run dev &
    echo $! > /tmp/privacy-coin-frontend.pid
    cd "$PROJECT_ROOT"
    log "Frontend starting on http://localhost:3000"
  fi

  # --- Summary ---
  echo ""
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║              Privacy Coin Localnet Ready                         ║"
  echo "╠════════════════════════════════════════════════════════════╣"
  echo "║                                                           ║"
  echo "║  Bitcoin Regtest:   http://localhost:3002                  ║"
  echo "║  Solana Validator:  http://localhost:8899                  ║"
  echo "║  Frontend:          http://localhost:3000                  ║"
  echo "║  zkBTC Mint:        ${ZKBTC_MINT:-unknown}  ║"
  echo "║                                                           ║"
  echo "║  Stop:  ./scripts/setup.sh localnet --stop                ║"
  echo "║  Seed:  ./scripts/setup.sh localnet --seed-only           ║"
  echo "║                                                           ║"
  echo "╚════════════════════════════════════════════════════════════╝"
}

# =============================================================================
# SEED DATA (full e2e: real BTC deposit + shield SPL + transfer + unshield + withdraw)
# =============================================================================
seed_mock_data() {
  step "Seeding Real On-Chain Data (full e2e lifecycle)"

  # Run the full e2e suite which does:
  #   Step 1: Infrastructure (validator + regtest + programs + tokens + VK hashes)
  #   Step 2: Register tUSDC + tWSOL tokens
  #   Step 3: Real BTC deposit via SPV (OP_RETURN → sweep → 6 confirms → header relay → verify)
  #   Step 4: Demo deposit (30k sats)
  #   Step 5: Shield SPL tokens (1B tUSDC + 5B tWSOL)
  #   Step 6: JoinSplit transfer (30k → 15k + 15k with Groth16 proof)
  #   Step 7: Unshield tUSDC (Groth16 proof → burn → SPL transfer)
  #   Step 8: BTC withdrawal request (15k sats → RedemptionRequest PDA)
  #   Step 9: Summary

  if ! curl -sf http://localhost:3002/regtest/api/blocks/tip/height > /dev/null 2>&1; then
    warn "Bitcoin regtest not running — cannot run full e2e"
    warn "Start regtest first: docker compose -f docker-compose.regtest.yml up -d"
    return 1
  fi

  log "Running full e2e suite (steps 1-9)..."
  log "This starts a fresh validator, deploys programs, and runs all transaction types."
  log ""

  bun run scripts/e2e/run-all.ts 2>&1 | sed 's/^/  /'
  E2E_EXIT=$?

  if [ $E2E_EXIT -ne 0 ]; then
    err "E2E suite failed — check output above"
    return 1
  fi

  # Read the e2e state to get the mint for .env.local
  if [ -f scripts/e2e/localnet-state.json ]; then
    ZKBTC_MINT=$(node -e "console.log(require('./scripts/e2e/localnet-state.json').zkbtcMint)" 2>/dev/null)
    POOL_BTC_ADDR=$(node -e "console.log(require('./scripts/e2e/localnet-state.json').poolBtcAddress||'')" 2>/dev/null)
    log "E2E mint: $ZKBTC_MINT"
    [ -n "$POOL_BTC_ADDR" ] && log "Pool BTC: $POOL_BTC_ADDR"
  fi
}

# =============================================================================
# DISPATCH
# =============================================================================
case "$NETWORK" in
  localnet|local) setup_localnet ;;
  devnet|dev)     setup_devnet ;;
  mainnet|main)   setup_mainnet ;;
  *)
    err "Unknown network: $NETWORK"
    echo "Usage: ./scripts/setup.sh <localnet|devnet|mainnet>"
    exit 1
    ;;
esac
