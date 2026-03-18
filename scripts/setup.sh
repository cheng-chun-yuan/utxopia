#!/usr/bin/env bash
# =============================================================================
# Aegis Unified Setup
#
# One command to set up any environment:
#   ./scripts/setup.sh localnet    — Full local stack + mock data
#   ./scripts/setup.sh devnet      — Configure for devnet
#   ./scripts/setup.sh mainnet     — Configure for mainnet (read-only)
#   ./scripts/setup.sh localnet --stop  — Stop all local services
#
# Localnet starts:
#   1. Bitcoin regtest (Esplora Docker on port 3002)
#   2. Solana test validator (port 8899) with BN254
#   3. Deploy & init programs + register tokens
#   4. Seed mock data (demo deposits + real BTC deposit)
#   5. Backend API (port 3001)
#   6. Frontend dev server (port 3000)
#
# Prerequisites:
#   - bun installed
#   - Docker running (localnet only)
#   - solana-test-validator installed (localnet only)
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

NETWORK="${1:-}"
FLAG="${2:-}"

if [ -z "$NETWORK" ]; then
  echo "Usage: ./scripts/setup.sh <localnet|devnet|mainnet> [--stop|--seed-only]"
  echo ""
  echo "  localnet   Full local stack (Bitcoin regtest + Solana validator + backend + frontend)"
  echo "  devnet     Configure .env for Solana devnet + Bitcoin testnet4"
  echo "  mainnet    Configure .env for mainnet (read-only, no deploy)"
  echo ""
  echo "Flags:"
  echo "  --stop       Stop all localnet services"
  echo "  --seed-only  Only seed mock data (assumes services already running)"
  echo "  --no-frontend  Skip starting Next.js dev server"
  exit 1
fi

# =============================================================================
# STOP
# =============================================================================
stop_all() {
  log "Stopping all services..."
  for pidfile in /tmp/aegis-frontend.pid /tmp/aegis-backend.pid /tmp/aegis-validator.pid; do
    if [ -f "$pidfile" ]; then
      kill "$(cat "$pidfile")" 2>/dev/null || true
      rm -f "$pidfile"
    fi
  done
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

  cat > aegis-app/.env.local << 'EOF'
# Aegis Frontend — Devnet Configuration
NEXT_PUBLIC_NETWORK=devnet
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_BTC_NETWORK=testnet4
NEXT_PUBLIC_AEGIS_PROGRAM_ID=8fqRet9WB5PECvKfWmzTPSusJgQz1onzxTLfHD75XKim
TRACKER_API_URL=https://api-aegis.amidoggy.xyz
BACKEND_URL=https://api-aegis.amidoggy.xyz
BACKEND_API_KEY=aegis-backend-2026
EOF

  log "Written: aegis-app/.env.local"
  log ""
  log "Devnet configured. Run: cd aegis-app && bun run dev"
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

  cat > aegis-app/.env.local << 'EOF'
# Aegis Frontend — Mainnet Configuration (read-only)
NEXT_PUBLIC_NETWORK=mainnet
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
NEXT_PUBLIC_BTC_NETWORK=mainnet
# NEXT_PUBLIC_AEGIS_PROGRAM_ID=  # Not deployed yet
# TRACKER_API_URL=               # Not deployed yet
EOF

  log "Written: aegis-app/.env.local"
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
  command -v solana-test-validator >/dev/null 2>&1 || { err "solana-test-validator not found"; exit 1; }
  command -v docker >/dev/null 2>&1 || { err "Docker not found"; exit 1; }
  command -v bun >/dev/null 2>&1 || { err "bun not found"; exit 1; }

  AEGIS_SO="contracts/target/deploy/aegis_pinocchio.so"
  BTC_LC_SO="contracts/target/deploy/btc_light_client.so"
  if [ ! -f "$AEGIS_SO" ]; then
    err "Aegis program not built. Run: cd contracts && cargo build-sbf --features devnet"
    exit 1
  fi
  if [ ! -f "$BTC_LC_SO" ]; then
    err "BTC light client not built. Run: cd contracts && cargo build-sbf --features devnet"
    exit 1
  fi
  log "Prerequisites OK"

  # --- Step 2: Bitcoin Regtest ---
  step "Step 2: Bitcoin Regtest (Esplora)"
  if docker ps --format '{{.Names}}' | grep -q aegis-esplora-regtest; then
    info "Esplora already running"
  else
    docker compose -f docker-compose.regtest.yml up -d 2>/dev/null
  fi

  ESPLORA_URL="http://localhost:3002/regtest/api"
  log "Waiting for Esplora..."
  for i in $(seq 1 60); do
    if curl -sf "$ESPLORA_URL/blocks/tip/height" > /dev/null 2>&1; then
      break
    fi
    [ "$i" -eq 60 ] && { err "Esplora timeout"; exit 1; }
    sleep 2
  done
  TIP=$(curl -sf "$ESPLORA_URL/blocks/tip/height")
  log "Esplora ready (tip: $TIP)"

  # --- Step 3: Solana Validator ---
  step "Step 3: Solana Test Validator"
  if curl -sf http://127.0.0.1:8899 -X POST -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' > /dev/null 2>&1; then
    info "Validator already running"
  else
    log "Starting validator with programs..."
    AEGIS_PROG_ID="8fqRet9WB5PECvKfWmzTPSusJgQz1onzxTLfHD75XKim"
    BTC_LC_PROG_ID="Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq"

    rm -rf test-ledger 2>/dev/null
    solana-test-validator --reset --quiet \
      --bpf-program "$AEGIS_PROG_ID" "$AEGIS_SO" \
      --bpf-program "$BTC_LC_PROG_ID" "$BTC_LC_SO" \
      &
    echo $! > /tmp/aegis-validator.pid

    for i in $(seq 1 30); do
      if curl -sf http://127.0.0.1:8899 -X POST -H "Content-Type: application/json" \
           -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' > /dev/null 2>&1; then
        break
      fi
      [ "$i" -eq 30 ] && { err "Validator timeout"; exit 1; }
      sleep 1
    done
    log "Validator ready"
  fi

  # Airdrop SOL
  solana config set --url http://127.0.0.1:8899 > /dev/null 2>&1
  solana airdrop 100 > /dev/null 2>&1 || true

  # --- Step 4: Initialize Programs ---
  step "Step 4: Initialize Aegis Pool + Register Tokens"
  RPC_URL=http://localhost:8899 node scripts/init-devnet.mjs 2>&1 | sed 's/^/  /'

  # Read back the mint from the pool
  ZKBTC_MINT=$(node -e "
    const {Connection,PublicKey}=require('@solana/web3.js');
    (async()=>{
      const c=new Connection('http://localhost:8899');
      const [ps]=PublicKey.findProgramAddressSync([Buffer.from('pool_state')],new PublicKey('8fqRet9WB5PECvKfWmzTPSusJgQz1onzxTLfHD75XKim'));
      const i=await c.getAccountInfo(ps);
      console.log(new PublicKey(i.data.slice(36,68)).toBase58());
    })();
  " 2>/dev/null)

  # --- Step 5: Generate .env.local ---
  step "Step 5: Write .env.local"
  cat > aegis-app/.env.local << EOF
# Aegis Frontend — Localnet (auto-generated by setup.sh)
NEXT_PUBLIC_NETWORK=localnet
NEXT_PUBLIC_SOLANA_RPC_URL=http://localhost:8899
NEXT_PUBLIC_BTC_NETWORK=regtest
NEXT_PUBLIC_AEGIS_PROGRAM_ID=8fqRet9WB5PECvKfWmzTPSusJgQz1onzxTLfHD75XKim
NEXT_PUBLIC_ZKBTC_MINT=${ZKBTC_MINT}
TRACKER_API_URL=http://localhost:3001
BACKEND_URL=http://localhost:3001
BACKEND_API_KEY=localnet-dev-key
ADMIN_KEYPAIR=$(cat ~/.config/solana/id.json 2>/dev/null || echo "[]")
RELAYER_KEYPAIR=$(cat ~/.config/solana/id.json 2>/dev/null || echo "[]")
EOF
  log "Written: aegis-app/.env.local (mint: ${ZKBTC_MINT})"

  # --- Step 6: Seed Mock Data ---
  seed_mock_data

  # --- Step 7: Start Frontend ---
  if [ "$NO_FRONTEND" = false ]; then
    step "Step 7: Frontend"
    cd aegis-app
    pkill -f "next dev" 2>/dev/null || true
    sleep 1
    bun run dev &
    echo $! > /tmp/aegis-frontend.pid
    cd "$PROJECT_ROOT"
    log "Frontend starting on http://localhost:3000"
  fi

  # --- Summary ---
  echo ""
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║              Aegis Localnet Ready                         ║"
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
# SEED MOCK DATA
# =============================================================================
seed_mock_data() {
  step "Seeding Mock Data"

  # Read mint from pool state
  ZKBTC_MINT=$(node -e "
    const {Connection,PublicKey}=require('@solana/web3.js');
    (async()=>{
      const c=new Connection('http://localhost:8899');
      const [ps]=PublicKey.findProgramAddressSync([Buffer.from('pool_state')],new PublicKey('8fqRet9WB5PECvKfWmzTPSusJgQz1onzxTLfHD75XKim'));
      const i=await c.getAccountInfo(ps);
      if(!i){console.log('');process.exit(0);}
      console.log(new PublicKey(i.data.slice(36,68)).toBase58());
    })();
  " 2>/dev/null)

  if [ -z "$ZKBTC_MINT" ]; then
    err "Pool not initialized. Run: ./scripts/setup.sh localnet"
    return 1
  fi

  # Generate a test stealth address if not provided
  TEST_ADDR=$(node -e "
    const {deriveKeysFromSeed,createStealthMetaAddress,encodeStealthMetaAddress}=require('@aegis/sdk');
    const seed=new Uint8Array(32);seed.fill(0xaa);
    const keys=deriveKeysFromSeed(seed);
    const meta=createStealthMetaAddress(keys);
    console.log(encodeStealthMetaAddress(meta));
  " 2>/dev/null || echo "")

  if [ -z "$TEST_ADDR" ]; then
    warn "Could not generate test stealth address (SDK not built?). Skipping mock data."
    return 0
  fi

  log "Test stealth address: ${TEST_ADDR:0:30}..."

  # Seed 3 demo deposits with different amounts
  log "Creating demo deposits..."
  for amount in 50000 100000 25000; do
    ZKBTC_MINT="$ZKBTC_MINT" RPC_URL=http://localhost:8899 \
      node scripts/topup-stealth.mjs "$TEST_ADDR" "$amount" 2>&1 | grep -E "TOP-UP|Amount|Error" | sed 's/^/  /'
  done

  # Run real BTC deposit if e2e scripts are available and regtest is running
  if curl -sf http://localhost:3002/regtest/api/blocks/tip/height > /dev/null 2>&1; then
    log "Creating real BTC deposit via SPV..."

    # Check if e2e state exists, if not run step1 first
    if [ ! -f scripts/e2e/localnet-state.json ] || \
       ! node -e "const s=require('./scripts/e2e/localnet-state.json');if(s.zkbtcMint!=='$ZKBTC_MINT')process.exit(1)" 2>/dev/null; then
      log "Running e2e step1 (infrastructure)..."
      bun run scripts/e2e/step1-infra.ts 2>&1 | grep -E "PASS|FAIL|Error" | sed 's/^/  /'
    fi

    # Run real BTC deposit
    if [ -f scripts/e2e/localnet-state.json ]; then
      bun run scripts/e2e/step3-btc-deposit.ts 2>&1 | grep -E "PASS|FAIL|Deposit|Sweep|Header|Commitment|Error" | sed 's/^/  /'
    fi
  else
    info "Bitcoin regtest not running — skipping real BTC deposit"
  fi

  # Summary
  TREE_SIZE=$(curl -sf http://localhost:3000/api/merkle/status 2>/dev/null | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).size)}catch{console.log('?')}})" 2>/dev/null || echo "?")
  log "Mock data seeded: $TREE_SIZE commitments in tree"
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
