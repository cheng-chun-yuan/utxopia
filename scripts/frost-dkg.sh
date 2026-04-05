#!/usr/bin/env bash
# =============================================================================
# FROST DKG Ceremony
#
# Runs a DKG ceremony against FROST signers running in Docker.
# Produces a 2-of-3 threshold key set and prints the group public key.
#
# Usage:
#   ./scripts/frost-dkg.sh
#   FROST_NETWORK=testnet4 ./scripts/frost-dkg.sh
#
# Prerequisites:
#   - FROST signers running: docker compose -f docker-compose.local.yml up -d
#   - frost-server binary built: cd frost_server && cargo build
# =============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${GREEN}[frost-dkg]${NC} $1"; }
warn() { echo -e "${YELLOW}[frost-dkg]${NC} $1"; }
err()  { echo -e "${RED}[frost-dkg]${NC} $1" >&2; }
step() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

# Source .env if it exists (Docker Compose reads it too)
[ -f "$PROJECT_ROOT/.env" ] && set -a && source "$PROJECT_ROOT/.env" && set +a

NETWORK="${FROST_NETWORK:-regtest}"
PASSWORD="${FROST_KEY_PASSWORD:-test}"
THRESHOLD="${FROST_THRESHOLD:-2}"
SIGNER_URLS="${FROST_SIGNER_URLS:-http://localhost:9001,http://localhost:9002,http://localhost:9003}"
API_KEY="${FROST_API_KEY:-}"

step "FROST DKG Ceremony ($NETWORK)"
log "Network:   $NETWORK"
log "Threshold: $THRESHOLD-of-3"
log "Signers:   $SIGNER_URLS"
log "Password:  ****"

# ─── Check signers are healthy ─────────────────────────────────────────────

step "Checking signer health"

IFS=',' read -ra URLS <<< "$SIGNER_URLS"
for url in "${URLS[@]}"; do
  url=$(echo "$url" | tr -d ' ')
  if curl -sf "$url/health" > /dev/null 2>&1; then
    log "  $url — healthy"
  else
    err "  $url — NOT responding"
    err "Start signers first: docker compose -f docker-compose.local.yml up --build -d"
    exit 1
  fi
done

# ─── Run DKG ───────────────────────────────────────────────────────────────

step "Running DKG ceremony"

# Check if frost-server binary exists
FROST_BIN="$PROJECT_ROOT/frost_server/target/debug/frost-server"
if [ ! -f "$FROST_BIN" ]; then
  FROST_BIN="$PROJECT_ROOT/frost_server/target/release/frost-server"
fi
if [ ! -f "$FROST_BIN" ]; then
  log "Building frost-server..."
  (cd "$PROJECT_ROOT/frost_server" && cargo build --bin frost-server 2>&1 | tail -3)
  FROST_BIN="$PROJECT_ROOT/frost_server/target/debug/frost-server"
fi

# Run the DKG coordinator
API_KEY_FLAG=""
[ -n "$API_KEY" ] && API_KEY_FLAG="--api-key $API_KEY"

DKG_OUTPUT=$("$FROST_BIN" dkg-coordinator \
  --signers "$SIGNER_URLS" \
  --threshold "$THRESHOLD" \
  --password "$PASSWORD" \
  $API_KEY_FLAG 2>&1)

echo "$DKG_OUTPUT"

# Extract group public key from output
GROUP_PUBKEY=$(echo "$DKG_OUTPUT" | grep -o 'Group public key (x-only): [a-f0-9]*' | awk '{print $NF}' || true)
if [ -z "$GROUP_PUBKEY" ]; then
  GROUP_PUBKEY=$(echo "$DKG_OUTPUT" | grep -o 'x-only.*: [a-f0-9]\{64\}' | awk '{print $NF}' || true)
fi

if [ -z "$GROUP_PUBKEY" ]; then
  err "Could not extract group public key from DKG output"
  exit 1
fi

TAPROOT_ADDR=$(echo "$DKG_OUTPUT" | grep -o 'Taproot address: [a-z0-9]*' | awk '{print $NF}' || true)

# ─── Save DKG state ────────────────────────────────────────────────────────

DKG_STATE="$PROJECT_ROOT/frost_server/config/dkg-state-${NETWORK}.json"
cat > "$DKG_STATE" << EOF
{
  "network": "$NETWORK",
  "groupPubKey": "$GROUP_PUBKEY",
  "taprootAddress": "$TAPROOT_ADDR",
  "threshold": $THRESHOLD,
  "participants": 3,
  "signerUrls": "$SIGNER_URLS",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# ─── Set group key on-chain ────────────────────────────────────────────────

step "Setting group key on-chain (set_pool_config disc=27)"

# Read program ID from localnet-state or env
STATE_FILE="$PROJECT_ROOT/scripts/e2e/localnet-state.json"
if [ -f "$STATE_FILE" ]; then
  PROGRAM_ID=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['privacyCoinProgramId'])")
elif [ -n "${PRIVACY_COIN_PROGRAM_ID:-}" ]; then
  PROGRAM_ID="$PRIVACY_COIN_PROGRAM_ID"
else
  err "No PRIVACY_COIN_PROGRAM_ID found. Set it in env or run E2E init first."
  exit 1
fi

log "Program ID: $PROGRAM_ID"
log "Group key:  $GROUP_PUBKEY"

# Call set_pool_config via inline bun script
bun -e "
const { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs');

(async () => {
  const rpc = '${PRIVACY_COIN_SOLANA_RPC:-http://localhost:8899}';
  const conn = new Connection(rpc, 'confirmed');
  const programId = new PublicKey('$PROGRAM_ID');

  // Load authority keypair
  const keyPath = process.env.HOME + '/.config/solana/id.json';
  const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));

  // Derive PDAs
  const [poolState] = PublicKey.findProgramAddressSync([Buffer.from('pool_state')], programId);
  const [poolConfig] = PublicKey.findProgramAddressSync([Buffer.from('pool_config')], programId);

  // Build instruction data: disc(27) + pool_script_len(1) + pool_script(34) + group_pub_key(32)
  // For Taproot p2tr, the scriptPubKey is: OP_1(0x51) + PUSH32(0x20) + x-only-pubkey(32) = 34 bytes
  const groupPubKey = Buffer.from('$GROUP_PUBKEY', 'hex');
  const poolScript = Buffer.alloc(34);
  poolScript[0] = 0x51; // OP_1 (witness v1)
  poolScript[1] = 0x20; // PUSH 32 bytes
  groupPubKey.copy(poolScript, 2);

  const data = Buffer.alloc(1 + 1 + 34 + 32);
  data[0] = 2; // SET_POOL_CONFIG disc
  data[1] = 34; // pool_script_len
  poolScript.copy(data, 2);
  groupPubKey.copy(data, 36);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: false },
      { pubkey: poolConfig, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [authority]);
  console.log('set_pool_config tx: ' + sig);
})().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
" 2>&1

if [ $? -ne 0 ]; then
  err "Failed to set pool config on-chain"
  exit 1
fi

# ─── Update localnet-state.json ────────────────────────────────────────────

if [ -f "$STATE_FILE" ]; then
  step "Updating localnet-state.json"
  python3 -c "
import json
with open('$STATE_FILE', 'r') as f:
    state = json.load(f)
state['poolBtcAddress'] = '$TAPROOT_ADDR'
state['btcXOnlyPubKey'] = '$GROUP_PUBKEY'
state['signingMode'] = 'frost'
with open('$STATE_FILE', 'w') as f:
    json.dump(state, f, indent=2)
print('Updated: poolBtcAddress, btcXOnlyPubKey, signingMode=frost')
"
  log "State file updated"

  # Re-sync env files
  PRIVACY_COIN_NETWORK=localnet "$PROJECT_ROOT/scripts/sync-env.sh"
fi

# ─── Summary ───────────────────────────────────────────────────────────────

step "FROST DKG Complete"
log "Group public key: $GROUP_PUBKEY"
[ -n "$TAPROOT_ADDR" ] && log "Taproot address:  $TAPROOT_ADDR"
log "Key files:        frost_server/config/signer{1,2,3}.key.enc"
log "DKG state:        $DKG_STATE"
log "On-chain:         PoolConfig PDA updated with group_pub_key"
log ""
log "Backend config (already in .env after sync):"
log "  PRIVACY_COIN_SIGNING_MODE=frost"
log "  PRIVACY_COIN_FROST_THRESHOLD=$THRESHOLD"
log "  PRIVACY_COIN_FROST_PARTICIPANTS=3"
log "  PRIVACY_COIN_FROST_SIGNER_URLS=$SIGNER_URLS"
