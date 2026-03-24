#!/usr/bin/env bash
#
# localnet-dev.sh — Full localnet dev workflow
#
# 1. Build contracts (--features localnet)
# 2. Run E2E steps 1-2 (infra + tokens) → creates validator, mints, PDAs
# 3. Sync env files
# 4. Start backend (indexes in real-time)
# 5. Run E2E steps 3-14 (deposits, transfers, unshields, redeems)
# 6. Restart frontend
#
# Usage:
#   ./scripts/localnet-dev.sh           # full run
#   ./scripts/localnet-dev.sh --skip-build  # skip contract build
#   ./scripts/localnet-dev.sh --only-services  # skip E2E, just start services

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

SKIP_BUILD=false
ONLY_SERVICES=false
for arg in "$@"; do
  case $arg in
    --skip-build) SKIP_BUILD=true ;;
    --only-services) ONLY_SERVICES=true ;;
  esac
done

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[localnet-dev]${NC} $1"; }
warn() { echo -e "${YELLOW}[localnet-dev]${NC} $1"; }
err() { echo -e "${RED}[localnet-dev]${NC} $1"; }

cleanup() {
  log "Cleaning up..."
  # Kill backend if we started it
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── Step 0: Build contracts ──
if [[ "$SKIP_BUILD" == false && "$ONLY_SERVICES" == false ]]; then
  log "Building contracts (--features localnet)..."
  (cd contracts && cargo build-sbf --features localnet)
fi

# ── Step 1-2: Infrastructure + Tokens ──
if [[ "$ONLY_SERVICES" == false ]]; then
  log "Running E2E infrastructure (steps 1-2)..."
  bun run scripts/e2e/step1-infra.ts
  bun run scripts/e2e/step2-tokens.ts
fi

# ── Sync env ──
log "Syncing env files..."
./scripts/sync-env.sh

# ── Kill old services ──
log "Killing old backend/frontend..."
pkill -f "zkbtc-api" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true
sleep 2

# ── Clean indexer DB for fresh state ──
rm -f backend/data/events.db
log "Cleaned indexer DB"

# ── Start backend (indexes in real-time) ──
log "Starting backend..."
(cd backend && cargo run --bin zkbtc-api > /tmp/aegis-backend.log 2>&1) &
BACKEND_PID=$!

# Wait for backend to be ready
for i in $(seq 1 30); do
  if curl -sf http://localhost:3001/api/tree/status > /dev/null 2>&1; then
    log "Backend ready (PID $BACKEND_PID)"
    break
  fi
  if [[ $i -eq 30 ]]; then
    err "Backend failed to start. Check /tmp/aegis-backend.log"
    exit 1
  fi
  sleep 1
done

# ── Run remaining E2E steps (3-14) with backend indexing in real-time ──
if [[ "$ONLY_SERVICES" == false ]]; then
  log "Running E2E steps 3-14 (backend indexing in real-time)..."
  STEPS=(
    "step3-btc-deposit.ts:BTC Deposit"
    "step4-btc-deposit-2.ts:BTC Deposit 2"
    "step5-shield.ts:Shield SPL"
    "step6-transfer.ts:JoinSplit Transfer"
    "step7-unshield.ts:Unshield tUSDC"
    "step7b-unshield-btc.ts:Unshield zkBTC"
    "step7c-multi-unshield.ts:Multi Unshield"
    "step8-btc-withdraw.ts:BTC Withdraw"
    "step8b-complete-redemption.ts:Complete Redemption"
    "step8c-multi-redeem.ts:Multi Redeem"
    "step9-summary.ts:Summary"
    "step10-security-negative.ts:Security Tests"
  )

  FAILED=false
  for entry in "${STEPS[@]}"; do
    IFS=: read -r file label <<< "$entry"
    log "Running $label..."
    if ! bun run "scripts/e2e/$file" 2>&1; then
      err "$label FAILED"
      FAILED=true
      break
    fi
  done

  if [[ "$FAILED" == true ]]; then
    warn "Some E2E steps failed. Backend is still running for debugging."
    warn "Backend logs: /tmp/aegis-backend.log"
  else
    log "All E2E steps passed!"
  fi

  # Give indexer a moment to finish processing
  sleep 3
fi

# ── Verify indexer data ──
log "Verifying indexer data..."
TRANSFERS=$(curl -sf http://localhost:3001/api/transfers 2>/dev/null || echo '{"transfers":[]}')
TOTAL=$(echo "$TRANSFERS" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.transfers.length)")
WITH_AMT=$(echo "$TRANSFERS" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.transfers.filter(t=>t.unshield_amount!=null).length)")
log "Transfers: $TOTAL total, $WITH_AMT with amounts"

TREE=$(curl -sf http://localhost:3001/api/tree/status 2>/dev/null || echo '{}')
log "Tree: $TREE"

# ── Start frontend ──
log "Starting frontend..."
(cd aegis-app && bun run dev > /tmp/aegis-frontend.log 2>&1) &
FRONTEND_PID=$!
sleep 5

if curl -sf http://localhost:3000 > /dev/null 2>&1; then
  log "Frontend ready at http://localhost:3000"
else
  warn "Frontend may still be starting... check /tmp/aegis-frontend.log"
fi

# ── Done ──
echo ""
log "════════════════════════════════════════"
log "  Localnet dev environment ready!"
log "  Frontend: http://localhost:3000"
log "  Backend:  http://localhost:3001"
log "  Logs:     /tmp/aegis-backend.log"
log "            /tmp/aegis-frontend.log"
log "════════════════════════════════════════"
echo ""
log "Press Ctrl+C to stop all services."

# Keep running until interrupted
wait
