#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# deploy-devnet.sh — Fresh Solana devnet + Bitcoin testnet4 deployment
#
# Usage:
#   ./scripts/deploy-devnet.sh                    # Full deploy
#   ./scripts/deploy-devnet.sh --resume           # Resume from last phase
#   ./scripts/deploy-devnet.sh --close-old         # Close old programs first (reclaim SOL)
#   ./scripts/deploy-devnet.sh --skip-dkg         # Skip Ika DKG (reuse existing dWallet)
#   ./scripts/deploy-devnet.sh --skip-deploy      # Skip contract deploy (reuse existing)
#   ./scripts/deploy-devnet.sh --rpc <url>        # Custom Solana RPC
#   ./scripts/deploy-devnet.sh --yes              # Skip confirmations
# =============================================================================

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="$ROOT/scripts/devnet-state.json"
PHASE_FILE="$ROOT/scripts/.deploy-devnet-phase"
CONFIG_FILE="$ROOT/contracts/config.json"
KEYPAIR_PATH="${KEYPAIR_PATH:-$HOME/.config/solana/johnny.json}"
RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
BTC_API="https://mempool.space/testnet4/api"
SKIP_DKG=false
SKIP_DEPLOY=false
CLOSE_OLD=false
RESUME=false
AUTO_YES=false

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-dkg)    SKIP_DKG=true; shift ;;
    --skip-deploy) SKIP_DEPLOY=true; shift ;;
    --close-old)   CLOSE_OLD=true; shift ;;
    --resume)      RESUME=true; shift ;;
    --yes)         AUTO_YES=true; shift ;;
    --rpc)         RPC_URL="$2"; shift 2 ;;
    *)             echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
err()   { echo -e "${RED}[✗]${NC} $1"; }
phase() { echo -e "\n${CYAN}════════════════════════════════════════${NC}"; echo -e "${CYAN}  Phase $1: $2${NC}"; echo -e "${CYAN}════════════════════════════════════════${NC}\n"; }

# State helpers
save_state() {
  local key="$1" val="$2"
  if [ ! -f "$STATE_FILE" ]; then
    echo '{}' > "$STATE_FILE"
  fi
  local tmp=$(mktemp)
  jq --arg k "$key" --arg v "$val" '. + {($k): $v}' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

read_state() {
  local key="$1"
  if [ -f "$STATE_FILE" ]; then
    jq -r --arg k "$key" '.[$k] // empty' "$STATE_FILE"
  fi
}

save_phase() {
  echo "$1" > "$PHASE_FILE"
}

get_phase() {
  if [ -f "$PHASE_FILE" ]; then
    cat "$PHASE_FILE"
  else
    echo "0"
  fi
}

confirm() {
  if [ "$AUTO_YES" = true ]; then return 0; fi
  echo -e "${YELLOW}$1 [y/N]${NC}"
  read -r answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# =============================================================================
# Phase 0: Prerequisites
# =============================================================================
run_phase_0() {
  phase 0 "Prerequisites Check"

  # Check tools
  for cmd in solana cargo-build-sbf bun jq; do
    if command -v "$cmd" &>/dev/null; then
      log "$cmd found"
    else
      err "$cmd not found. Please install it."
      exit 1
    fi
  done

  # Check keypair
  if [ ! -f "$KEYPAIR_PATH" ]; then
    err "Keypair not found at $KEYPAIR_PATH"
    err "Set KEYPAIR_PATH env var or create the file"
    exit 1
  fi
  local AUTHORITY=$(solana-keygen pubkey "$KEYPAIR_PATH" 2>/dev/null)
  log "Authority: $AUTHORITY"
  save_state "authority" "$AUTHORITY"

  # Check balance
  local BALANCE=$(solana balance "$AUTHORITY" --url "$RPC_URL" 2>/dev/null | awk '{print $1}')
  log "Devnet balance: ${BALANCE} SOL"
  if (( $(echo "$BALANCE < 2" | bc -l 2>/dev/null || echo 0) )); then
    warn "Balance may be too low for deployment. Need ~3 SOL."
    warn "Run: solana airdrop 5 $AUTHORITY --url $RPC_URL"
  fi

  # Check circuits
  if [ -d "$ROOT/circuits/build/joinsplit_1x2" ]; then
    log "Circuits built"
  else
    warn "Circuits not built. Run: cd circuits && bash scripts/compile.sh"
    warn "VK registration (phase 4) will be skipped."
  fi

  echo ""
  log "RPC: $RPC_URL"
  log "BTC API: $BTC_API"
  log "Keypair: $KEYPAIR_PATH"

  if ! confirm "Proceed with devnet deployment?"; then
    echo "Aborted."
    exit 0
  fi

  save_phase 0
}

# =============================================================================
# Close Old Programs (optional, --close-old)
# =============================================================================
close_old_programs() {
  if [ "$CLOSE_OLD" != true ]; then return; fi

  phase "X" "Close Old Programs (reclaim SOL)"

  local AUTHORITY=$(solana-keygen pubkey "$KEYPAIR_PATH" 2>/dev/null)
  local BEFORE=$(solana balance "$AUTHORITY" --url "$RPC_URL" 2>/dev/null | awk '{print $1}')
  log "Balance before: $BEFORE SOL"

  # Try closing old Privacy Coin program
  local OLD_PRIVACY_COIN=$(read_state "privacyCoinProgramId")
  if [ -n "$OLD_PRIVACY_COIN" ]; then
    log "Closing old Privacy Coin program: $OLD_PRIVACY_COIN"
    solana program close "$OLD_PRIVACY_COIN" \
      --url "$RPC_URL" \
      --keypair "$KEYPAIR_PATH" \
      --bypass-warning 2>&1 || warn "Failed to close $OLD_PRIVACY_COIN (may already be closed)"
  fi

  # Try closing old BTC LC program
  local OLD_BTCLC=$(read_state "btcLightClientId")
  if [ -n "$OLD_BTCLC" ]; then
    log "Closing old BTC LC program: $OLD_BTCLC"
    solana program close "$OLD_BTCLC" \
      --url "$RPC_URL" \
      --keypair "$KEYPAIR_PATH" \
      --bypass-warning 2>&1 || warn "Failed to close $OLD_BTCLC (may already be closed)"
  fi

  # Also try the known devnet2 programs
  for PID in "7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ"; do
    if solana program show "$PID" --url "$RPC_URL" 2>/dev/null | grep -q "Authority: $AUTHORITY"; then
      log "Closing known program: $PID"
      solana program close "$PID" \
        --url "$RPC_URL" \
        --keypair "$KEYPAIR_PATH" \
        --bypass-warning 2>&1 || warn "Failed to close $PID"
    fi
  done

  # Close any lingering buffer accounts
  log "Closing orphaned buffer accounts..."
  solana program close --buffers \
    --url "$RPC_URL" \
    --keypair "$KEYPAIR_PATH" 2>&1 || true

  local AFTER=$(solana balance "$AUTHORITY" --url "$RPC_URL" 2>/dev/null | awk '{print $1}')
  log "Balance after: $AFTER SOL (reclaimed $(echo "$AFTER - $BEFORE" | bc) SOL)"

  # Clear state for fresh deploy
  rm -f "$STATE_FILE"
  log "Cleared old state file"
}

# =============================================================================
# Phase 1: Build Contracts
# =============================================================================
run_phase_1() {
  phase 1 "Build Contracts"

  cd "$ROOT/contracts"
  cargo build-sbf --features devnet 2>&1 | tail -3
  cd "$ROOT"

  # Verify .so files
  local PRIVACY_COIN_SO="$ROOT/contracts/target/deploy/privacy_coin.so"
  local BTCLC_SO="$ROOT/contracts/target/deploy/btc_light_client.so"

  if [ ! -f "$PRIVACY_COIN_SO" ]; then err "privacy_coin.so not found"; exit 1; fi
  if [ ! -f "$BTCLC_SO" ]; then err "btc_light_client.so not found"; exit 1; fi

  # Extract program IDs from keypairs
  local PRIVACY_COIN_KP="$ROOT/contracts/target/deploy/privacy_coin-keypair.json"
  local BTCLC_KP="$ROOT/contracts/target/deploy/btc_light_client-keypair.json"

  local PRIVACY_COIN_ID=$(solana-keygen pubkey "$PRIVACY_COIN_KP" 2>/dev/null)
  local BTCLC_ID=$(solana-keygen pubkey "$BTCLC_KP" 2>/dev/null)

  log "Privacy Coin program ID: $PRIVACY_COIN_ID"
  log "BTC LC program ID: $BTCLC_ID"

  save_state "privacyCoinProgramId" "$PRIVACY_COIN_ID"
  save_state "btcLightClientId" "$BTCLC_ID"

  save_phase 1
}

# =============================================================================
# Phase 2: Deploy Programs
# =============================================================================
run_phase_2() {
  phase 2 "Deploy Programs to Devnet"

  local PRIVACY_COIN_ID=$(read_state "privacyCoinProgramId")
  local BTCLC_ID=$(read_state "btcLightClientId")
  local PRIVACY_COIN_SO="$ROOT/contracts/target/deploy/privacy_coin.so"
  local BTCLC_SO="$ROOT/contracts/target/deploy/btc_light_client.so"
  local PRIVACY_COIN_KP="$ROOT/contracts/target/deploy/privacy_coin-keypair.json"
  local BTCLC_KP="$ROOT/contracts/target/deploy/btc_light_client-keypair.json"

  log "Deploying Privacy Coin ($PRIVACY_COIN_ID)..."
  solana program deploy "$PRIVACY_COIN_SO" \
    --program-id "$PRIVACY_COIN_KP" \
    --url "$RPC_URL" \
    --keypair "$KEYPAIR_PATH" \
    --with-compute-unit-price 50000 \
    || { err "Privacy Coin deploy failed"; exit 1; }
  log "Privacy Coin deployed!"

  sleep 3

  log "Deploying BTC Light Client ($BTCLC_ID)..."
  solana program deploy "$BTCLC_SO" \
    --program-id "$BTCLC_KP" \
    --url "$RPC_URL" \
    --keypair "$KEYPAIR_PATH" \
    --with-compute-unit-price 50000 \
    || { err "BTC LC deploy failed"; exit 1; }
  log "BTC Light Client deployed!"

  # Update contracts/config.json
  local tmp=$(mktemp)
  jq --arg aegis "$PRIVACY_COIN_ID" --arg btclc "$BTCLC_ID" \
    '.programs.devnet.Privacy Coin = $aegis | .programs.devnet.btc_light_client = $btclc' \
    "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
  log "Updated contracts/config.json"

  save_phase 2
}

# =============================================================================
# Phase 3: Initialize Pool + Tokens
# =============================================================================
run_phase_3() {
  phase 3 "Initialize Pool + Register Tokens"

  local PRIVACY_COIN_ID=$(read_state "privacyCoinProgramId")

  log "Running init-devnet.ts..."
  local OUTPUT=$(PRIVACY_COIN_PROGRAM_ID="$PRIVACY_COIN_ID" \
    RPC_URL="$RPC_URL" \
    KEYPAIR_PATH="$KEYPAIR_PATH" \
    bun run "$ROOT/scripts/init-devnet.ts" 2>&1)

  echo "$OUTPUT"

  # Parse outputs
  local ZKBTC=$(echo "$OUTPUT" | grep "Mint created:" | head -1 | awk '{print $NF}')
  local POOL_STATE=$(echo "$OUTPUT" | grep "Pool State PDA:" | awk '{print $NF}')
  local COMMIT_TREE=$(echo "$OUTPUT" | grep "Commitment Tree PDA:" | awk '{print $NF}')
  local POOL_VAULT=$(echo "$OUTPUT" | grep "Pool Vault:" | head -1 | awk '{print $NF}')
  local FROST_VAULT=$(echo "$OUTPUT" | grep "Frost Vault:" | head -1 | awk '{print $NF}')
  local USDC_MINT=$(echo "$OUTPUT" | grep "tUSDC Mint:" | awk '{print $NF}')
  local USDT_MINT=$(echo "$OUTPUT" | grep "tUSDT Mint:" | awk '{print $NF}')

  # Handle "already initialized" case
  if echo "$OUTPUT" | grep -q "already initialized"; then
    ZKBTC=$(echo "$OUTPUT" | grep "zkBTC Mint:" | awk '{print $NF}')
    POOL_VAULT=$(echo "$OUTPUT" | grep "Pool Vault:" | awk '{print $NF}')
    warn "Pool already initialized, using existing values"
  fi

  [ -n "$ZKBTC" ] && save_state "zkbtcMint" "$ZKBTC" && log "zkBTC Mint: $ZKBTC"
  [ -n "$POOL_STATE" ] && save_state "poolState" "$POOL_STATE"
  [ -n "$COMMIT_TREE" ] && save_state "commitmentTree" "$COMMIT_TREE"
  [ -n "$POOL_VAULT" ] && save_state "poolVault" "$POOL_VAULT"
  [ -n "$FROST_VAULT" ] && save_state "frostVault" "$FROST_VAULT"
  [ -n "$USDC_MINT" ] && save_state "tUsdcMint" "$USDC_MINT"
  [ -n "$USDT_MINT" ] && save_state "tUsdtMint" "$USDT_MINT"

  save_phase 3
}

# =============================================================================
# Phase 4: Register VK Hashes
# =============================================================================
run_phase_4() {
  phase 4 "Register VK Hashes"

  if [ ! -d "$ROOT/circuits/build/joinsplit_1x2" ]; then
    warn "Circuits not built — skipping VK registration"
    save_phase 4
    return
  fi

  local PRIVACY_COIN_ID=$(read_state "privacyCoinProgramId")

  log "Registering VK hashes..."
  PRIVACY_COIN_PROGRAM_ID="$PRIVACY_COIN_ID" \
    RPC_URL="$RPC_URL" \
    KEYPAIR_PATH="$KEYPAIR_PATH" \
    bun run "$ROOT/scripts/register-vk-hashes.ts" 2>&1

  log "VK hashes registered!"
  save_phase 4
}

# =============================================================================
# Phase 5: Initialize BTC Light Client
# =============================================================================
run_phase_5() {
  phase 5 "Initialize BTC Light Client"

  local BTCLC_ID=$(read_state "btcLightClientId")

  log "Initializing BTC Light Client on testnet4..."
  BTC_LIGHT_CLIENT_PROGRAM_ID="$BTCLC_ID" \
    RPC_URL="$RPC_URL" \
    KEYPAIR_PATH="$KEYPAIR_PATH" \
    BTC_API_URL="$BTC_API" \
    bun run "$ROOT/scripts/init-btc-light-client.ts" 2>&1

  log "BTC Light Client initialized!"
  save_phase 5
}

# =============================================================================
# Phase 6: Ika dWallet DKG
# =============================================================================
run_phase_6() {
  phase 6 "Ika dWallet DKG"

  if [ "$SKIP_DKG" = true ]; then
    warn "Skipping Ika DKG (--skip-dkg)"
    save_phase 6
    return
  fi

  local PRIVACY_COIN_ID=$(read_state "privacyCoinProgramId")
  if [ -z "$PRIVACY_COIN_ID" ]; then
    warn "privacyCoinProgramId not in state — run earlier phases first"
    save_phase 6
    return
  fi

  log "Installing scripts/ika-setup deps..."
  (cd "$ROOT/scripts/ika-setup" && bun install >/dev/null 2>&1)

  log "Running Ika DKG against Ika devnet (Secp256k1 + Taproot)..."
  PRIVACY_COIN_PROGRAM_ID="$PRIVACY_COIN_ID" \
    PAYER_KEYPAIR_PATH="$KEYPAIR_PATH" \
    node --experimental-strip-types --no-warnings \
      "$ROOT/scripts/ika-setup/dkg.ts" --network devnet 2>&1

  log "Submitting set_pool_config (disc 2) to pin the dWallet on-chain..."
  PRIVACY_COIN_PROGRAM_ID="$PRIVACY_COIN_ID" \
    PAYER_KEYPAIR_PATH="$KEYPAIR_PATH" \
    node --experimental-strip-types --no-warnings \
      "$ROOT/scripts/ika-setup/set-pool-config.ts" --network devnet 2>&1

  save_state "signingMode" "ika"
  log "Signing mode → ika"

  save_phase 6
}

# =============================================================================
# Phase 7: Update Configs + Sync Env
# =============================================================================
run_phase_7() {
  phase 7 "Update Configs + Sync Env"

  # Add timestamp
  save_state "createdAt" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Run env sync
  log "Syncing env files..."
  PRIVACY_COIN_NETWORK=devnet "$ROOT/scripts/sync-env.sh"

  log "Env files synced!"
  log "  backend/.env.devnet"
  log "  web/.env.devnet"

  save_phase 7
}

# =============================================================================
# Phase 8: Summary
# =============================================================================
run_phase_8() {
  phase 8 "Deployment Summary"

  echo -e "${GREEN}════════════════════════════════════════${NC}"
  echo -e "${GREEN}  DEVNET DEPLOYMENT COMPLETE${NC}"
  echo -e "${GREEN}════════════════════════════════════════${NC}"
  echo ""
  echo "Program IDs:"
  echo "  Aegis:          $(read_state privacyCoinProgramId)"
  echo "  BTC Light Client: $(read_state btcLightClientId)"
  echo ""
  echo "Addresses:"
  echo "  zkBTC Mint:     $(read_state zkbtcMint)"
  echo "  Pool State:     $(read_state poolState)"
  echo "  Pool Vault:     $(read_state poolVault)"
  echo "  tUSDC Mint:     $(read_state tUsdcMint)"
  echo "  tUSDT Mint:     $(read_state tUsdtMint)"
  echo ""
  echo "Ika dWallet custody:"
  echo "  dWallet:        $(read_state ika.dwallet 2>/dev/null || echo '<not set — run phase 6>')"
  echo "  x-only pubkey:  $(read_state ika.dwalletXOnlyPubkey 2>/dev/null || echo '<not set>')"
  echo "  CPI auth bump:  $(read_state ika.cpiAuthorityBump 2>/dev/null || echo '<not set>')"
  echo ""
  echo "Bitcoin (testnet4):"
  echo "  Pool Address:   $(read_state poolBtcAddress)"
  echo ""
  echo -e "${CYAN}═══ Railway Deployment ═══${NC}"
  echo ""
  echo "  cd backend && railway up --path-as-root ."
  echo ""
  echo "  Railway env vars to set:"
  echo "    PRIVACY_COIN_PROGRAM_ID=$(read_state privacyCoinProgramId)"
  echo "    PRIVACY_COIN_ZKBTC_MINT=$(read_state zkbtcMint)"
  echo "    BTC_LIGHT_CLIENT_PROGRAM_ID=$(read_state btcLightClientId)"
  echo "    PRIVACY_COIN_NETWORK=devnet"
  echo "    POOL_RECEIVE_ADDRESS=$(read_state poolBtcAddress)"
  echo "    PRIVACY_COIN_SIGNING_MODE=ika"
  echo "    PRIVACY_COIN_IKA_PROGRAM_ID=$(read_state ika.programId 2>/dev/null || echo)"
  echo "    PRIVACY_COIN_IKA_DWALLET=$(read_state ika.dwallet 2>/dev/null || echo)"
  echo "    PRIVACY_COIN_IKA_DWALLET_XONLY_PUBKEY=$(read_state ika.dwalletXOnlyPubkey 2>/dev/null || echo)"
  echo "    PRIVACY_COIN_IKA_CPI_AUTHORITY_BUMP=$(read_state ika.cpiAuthorityBump 2>/dev/null || echo)"
  echo "    HEADER_RELAY_ENABLED=true"
  echo "    MEMPOOL_WS_ENABLED=true"
  echo ""
  echo -e "${CYAN}═══ Vercel Frontend ═══${NC}"
  echo ""
  echo "  Env vars to set in Vercel:"
  echo "    NEXT_PUBLIC_PRIVACY_COIN_PROGRAM_ID=$(read_state privacyCoinProgramId)"
  echo "    NEXT_PUBLIC_ZKBTC_MINT=$(read_state zkbtcMint)"
  echo "    NEXT_PUBLIC_USDC_MINT=$(read_state tUsdcMint)"
  echo "    NEXT_PUBLIC_BACKEND_URL=https://api-aegis.amidoggy.xyz"
  echo ""
  echo -e "${YELLOW}═══ IMPORTANT ═══${NC}"
  echo "  Fund the pool taproot address with testnet4 BTC:"
  echo "  $(read_state poolBtcAddress)"
  echo ""
  echo "  State saved to: $STATE_FILE"

  # Clean up phase tracker
  rm -f "$PHASE_FILE"
}

# =============================================================================
# Main
# =============================================================================

echo -e "${CYAN}"
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║  Privacy Coin — Fresh Devnet Deployment          ║"
echo "  ║  Solana devnet + Bitcoin testnet4          ║"
echo "  ╚═══════════════════════════════════════════╝"
echo -e "${NC}"

LAST_PHASE=0
if [ "$RESUME" = true ] && [ -f "$PHASE_FILE" ]; then
  LAST_PHASE=$(get_phase)
  log "Resuming from phase $((LAST_PHASE + 1))"
fi

# Run phases
if [ "$SKIP_DEPLOY" = true ]; then
  # Use existing program IDs from config.json
  if [ $LAST_PHASE -lt 2 ]; then
    _PRIVACY_COIN_ID=$(jq -r '.programs.devnet.Aegis' "$CONFIG_FILE")
    _BTCLC_ID=$(jq -r '.programs.devnet.btc_light_client' "$CONFIG_FILE")
    save_state "privacyCoinProgramId" "$_PRIVACY_COIN_ID"
    save_state "btcLightClientId" "$_BTCLC_ID"
    log "Using existing program IDs from config.json"
    log "  Aegis: $_PRIVACY_COIN_ID"
    log "  BTC LC: $_BTCLC_ID"
    save_phase 2
    LAST_PHASE=2
  fi
fi

close_old_programs
[ $LAST_PHASE -lt 0 ] && run_phase_0
[ $LAST_PHASE -lt 1 ] && run_phase_1
[ $LAST_PHASE -lt 2 ] && run_phase_2
[ $LAST_PHASE -lt 3 ] && run_phase_3
[ $LAST_PHASE -lt 4 ] && run_phase_4
[ $LAST_PHASE -lt 5 ] && run_phase_5
[ $LAST_PHASE -lt 6 ] && run_phase_6
[ $LAST_PHASE -lt 7 ] && run_phase_7
run_phase_8
