#!/usr/bin/env bash
#
# localnet-docker-frost.sh — Bring up localnet with Dockerized FROST signers
#
# Flow:
#   1. Run localnet setup/E2E to create validator, regtest, and localnet-state.json
#   2. Start Docker FROST signers on localhost:9001-9003
#   3. Run regtest DKG and write FROST group key back to localnet-state.json
#   4. Regenerate backend/web env for localnet
#
# Usage:
#   ./scripts/localnet-docker-frost.sh
#   ./scripts/localnet-docker-frost.sh --skip-setup
#   ./scripts/localnet-docker-frost.sh --skip-dkg

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_SETUP=false
SKIP_DKG=false

for arg in "$@"; do
  case "$arg" in
    --skip-setup) SKIP_SETUP=true ;;
    --skip-dkg) SKIP_DKG=true ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: ./scripts/localnet-docker-frost.sh [--skip-setup] [--skip-dkg]"
      exit 1
      ;;
  esac
done

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[localnet-frost]${NC} $1"; }
warn() { echo -e "${YELLOW}[localnet-frost]${NC} $1"; }
err()  { echo -e "${RED}[localnet-frost]${NC} $1" >&2; }
step() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

export FROST_API_KEY="${FROST_API_KEY:-localnet-frost-key}"
export FROST_KEY_PASSWORD="${FROST_KEY_PASSWORD:-test}"
export FROST_NETWORK="${FROST_NETWORK:-regtest}"
export FROST_ESPLORA_URL="${FROST_ESPLORA_URL:-http://host.docker.internal:3002/regtest/api}"

if [ "$SKIP_SETUP" = false ]; then
  step "Localnet setup"
  ./scripts/setup.sh localnet
else
  log "Skipping localnet setup"
fi

step "Start Docker FROST signers"
docker compose -f docker-compose.local.yml up --build -d

log "Waiting for FROST signers..."
for port in 9001 9002 9003; do
  until curl -sf "http://localhost:${port}/health" > /dev/null 2>&1; do
    sleep 1
  done
  log "Signer ready on :${port}"
done

if [ "$SKIP_DKG" = false ]; then
  step "Run regtest DKG"
  ./scripts/frost-dkg.sh
else
  warn "Skipping DKG"
fi

step "Sync localnet env"
PRIVACY_COIN_NETWORK=localnet ./scripts/sync-env.sh
ln -sf .env.localnet web/.env.local

step "Summary"
echo "web:     http://localhost:3000"
echo "backend: http://localhost:3001"
echo "frost:   http://localhost:9001,http://localhost:9002,http://localhost:9003"
echo ""
echo "Start backend locally:"
echo "  cd backend && BACKEND_API_KEY=localnet-dev-key PRIVACY_COIN_FROST_API_KEY=${FROST_API_KEY} RELAYER_KEYPAIR=\"\$(cat ~/.config/solana/id.json)\" cargo run --bin zkbtc-api"
echo ""
echo "Start frontend locally:"
echo "  cd web && bun run dev"
