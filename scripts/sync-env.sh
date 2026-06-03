#!/usr/bin/env bash
#
# sync-env.sh — Single source of truth config generator
#
# Reads {network}-state.json and generates ALL config files:
#   1. backend/.env.{network} + symlink backend/.env
#   2. web/.env.{network} + symlink web/.env.local
#   3. web/src/lib/networks.json (frontend config)
#
# Usage:
#   ./scripts/sync-env.sh
#   UTXOPIA_NETWORK=localnet ./scripts/sync-env.sh
#   UTXOPIA_NETWORK=sui-testnet ./scripts/sync-env.sh
#   UTXOPIA_NETWORK=sui-regtest ./scripts/sync-env.sh
#
# After deploying: update scripts/devnet-state.json, then run this script.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK="${UTXOPIA_NETWORK:-devnet}"

echo "=== UTXOpia Config Sync ==="
echo "Network: $NETWORK"
echo ""

# ─── Load state file ──────────────────────────────────────────────────────────

case "$NETWORK" in
  localnet)
    STATE_FILE="$ROOT/scripts/e2e/localnet-state.json"
    ;;
  devnet)
    STATE_FILE="$ROOT/scripts/devnet-state.json"
    ;;
  devnet-regtest)
    STATE_FILE="$ROOT/scripts/devnet-regtest-state.json"
    ;;
  sui-testnet)
    STATE_FILE="$ROOT/chains/sui/sui-poc-state.json"
    ;;
  sui-regtest)
    STATE_FILE="$ROOT/chains/sui/sui-poc-state.json"
    ;;
  *)
    echo "ERROR: Unknown network '$NETWORK'. Use: localnet, devnet, devnet-regtest, sui-testnet, sui-regtest"
    exit 1
    ;;
esac

if [ ! -f "$STATE_FILE" ]; then
  echo "ERROR: $STATE_FILE not found."
  echo "Run the deploy/init script first."
  exit 1
fi

# Helper to read JSON fields (works without jq)
jval() {
  python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('$1',''))"
}

# ─── Read all values from state file ──────────────────────────────────────────

PROGRAM_ID=$(jval utxopiaProgramId)
BTC_LC_ID=$(jval btcLightClientId)
ZKBTC_MINT=$(jval zkbtcMint)
POOL_STATE=$(jval poolState)
COMMITMENT_TREE=$(jval commitmentTree)
POOL_VAULT=$(jval poolVault)
FROST_VAULT=$(jval frostVault)
POOL_AUTHORITY=$(jval poolAuthority)

WSOL_MINT=$(jval wsolMint)
USDC_MINT=$(jval tUsdcMint)
USDT_MINT=$(jval tUsdtMint)
JUPUSD_MINT=$(jval jupUsdMint)
WSOL_VAULT=$(jval wsolVault)
USDC_VAULT=$(jval tUsdcVault)
USDT_VAULT=$(jval tUsdtVault)
JUPUSD_VAULT=$(jval jupUsdVault)

GROUP_PUBKEY=$(jval btcXOnlyPubKey)
POOL_BTC_ADDR=$(jval poolBtcAddress)
BTC_NETWORK=$(jval btcNetwork)
SOLANA_RPC=$(jval solanaRpc)
BACKEND_URL=$(jval backendUrl)

SIGNING_MODE=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('signingMode','relayer' if '$NETWORK' in ('sui-testnet','sui-regtest') else 'frost'))")
DEPOSIT_MODE=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); s=d.get('signingMode','frost'); ika=d.get('ika',{}).get('dwalletXOnlyPubkey',''); has_ika=bool(ika and any(c not in '0' for c in ika.lower())); print(d.get('depositMode', 'direct' if s == 'ika' and has_ika else 'sweep'))")

# Ika dWallet integration (nested under "ika" — fall back to empty string if absent).
IKA_PROGRAM_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ika',{}).get('programId',''))")
IKA_GRPC_ENDPOINT=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ika',{}).get('grpcEndpoint',''))")
IKA_DWALLET=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ika',{}).get('dwallet',''))")
IKA_DWALLET_XONLY_PUBKEY=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ika',{}).get('dwalletXOnlyPubkey',''))")
IKA_CPI_AUTHORITY_BUMP=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ika',{}).get('cpiAuthorityBump',0))")

# Sui testnet POC integration (top-level in chains/sui/sui-poc-state.json).
SUI_NETWORK=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('network','testnet'))")
SUI_RPC_URL=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('rpcUrl','https://fullnode.testnet.sui.io:443'))")
SUI_PACKAGE_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('packageId',''))")
SUI_RELAYER_ADDRESS=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('relayer',{}).get('address',''))")
SUI_RELAYER_KEYPAIR_PATH=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('relayer',{}).get('keypairPath',''))")
SUI_RELAYER_KEY_SCHEME=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('relayer',{}).get('keyScheme','ed25519'))")
SUI_SUINS_PARENT_NFT_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('suins',{}).get('parentNftId', d.get('suinsParentNftId','')))")
SUI_GAS_BUDGET=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('gasBudget','100000000'))")
SUI_IKA_NETWORK=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('network','testnet'))")
SUI_IKA_PACKAGE=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('packages',{}).get('ikaPackage',''))")
SUI_IKA_COMMON_PACKAGE=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('packages',{}).get('ikaCommonPackage',''))")
SUI_IKA_SYSTEM_PACKAGE=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('packages',{}).get('ikaSystemPackage',''))")
SUI_IKA_DWALLET_2PC_MPC_PACKAGE=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('packages',{}).get('ikaDwallet2pcMpcPackage',''))")
SUI_IKA_SYSTEM_OBJECT_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('objects',{}).get('ikaSystemObject',{}).get('objectID',''))")
SUI_IKA_SYSTEM_OBJECT_VERSION=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('objects',{}).get('ikaSystemObject',{}).get('initialSharedVersion',''))")
SUI_IKA_DWALLET_COORDINATOR_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('objects',{}).get('ikaDWalletCoordinator',{}).get('objectID',''))")
SUI_IKA_DWALLET_COORDINATOR_VERSION=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('objects',{}).get('ikaDWalletCoordinator',{}).get('initialSharedVersion',''))")
SUI_IKA_DWALLET_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('dWalletId',''))")
SUI_IKA_DWALLET_CAP_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('dWalletCapObjectId',''))")
SUI_IKA_NETWORK_ENCRYPTION_KEY_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('networkEncryptionKeyId',''))")
SUI_IKA_COIN_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('ikaCoinObjectId',''))")
SUI_IKA_SUI_COIN_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('ikaSui',{}).get('suiCoinObjectId',''))")
SUI_POOL_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('pool',{}).get('objectId',''))")
SUI_POOL_VERSION=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('pool',{}).get('initialSharedVersion',''))")
SUI_BTC_DEPOSIT_REGISTRY_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('btcDepositRegistry',{}).get('objectId',''))")
SUI_BTC_DEPOSIT_REGISTRY_VERSION=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('btcDepositRegistry',{}).get('initialSharedVersion',''))")
SUI_NULLIFIER_REGISTRY_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('nullifierRegistry',{}).get('objectId',''))")
SUI_NULLIFIER_REGISTRY_VERSION=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('nullifierRegistry',{}).get('initialSharedVersion',''))")
SUI_REDEMPTION_QUEUE_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('redemptionQueue',{}).get('objectId',''))")
SUI_REDEMPTION_QUEUE_VERSION=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('redemptionQueue',{}).get('initialSharedVersion',''))")
SUI_REDEMPTION_CAP_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('redemptionCap',{}).get('objectId',''))")
SUI_REDEMPTION_CAP_VERSION=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('redemptionCap',{}).get('version',''))")
SUI_REDEMPTION_CAP_DIGEST=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('redemptionCap',{}).get('digest',''))")
SUI_VERIFYING_KEY_REGISTRY_ID=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('verifyingKeyRegistry',{}).get('objectId',''))")
SUI_VERIFYING_KEY_REGISTRY_VERSION=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d.get('verifyingKeyRegistry',{}).get('initialSharedVersion',''))")

# Defaults for fields not in state file are applied per network below.
BACKEND_URL="${BACKEND_URL:-}"
PUBLIC_REGTEST_BTC_EXPLORER="${PUBLIC_REGTEST_BTC_EXPLORER:-${BTC_EXPLORER_URL:-https://btc.utxopia.com/regtest}}"

# Network-specific overrides
case "$NETWORK" in
  localnet)
    SOLANA_RPC="${SOLANA_RPC:-http://localhost:8899}"
    BTC_NETWORK="${BTC_NETWORK:-regtest}"
    BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
    TRACKER_API_PORT="${TRACKER_API_PORT:-3001}"
    BTC_EXPLORER="$PUBLIC_REGTEST_BTC_EXPLORER"
    ESPLORA_URL="http://localhost:3002/regtest/api"
    MEMPOOL_WS="false"
    ;;
  devnet)
    SOLANA_RPC="${SOLANA_RPC:-https://api.devnet.solana.com}"
    BTC_NETWORK="${BTC_NETWORK:-testnet4}"
    BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
    BTC_EXPLORER="https://mempool.space/testnet4"
    ESPLORA_URL="https://mempool.space/testnet4/api"
    MEMPOOL_WS="true"
    TRACKER_API_PORT="${TRACKER_API_PORT:-3001}"
    ;;
  devnet-regtest)
    SOLANA_RPC="${SOLANA_RPC:-https://api.devnet.solana.com}"
    BTC_NETWORK="${BTC_NETWORK:-regtest}"
    BACKEND_URL="${BACKEND_URL:-https://api-hybrid.utxopia.com}"
    TRACKER_API_PORT="${TRACKER_API_PORT:-3020}"
    BTC_EXPLORER="$PUBLIC_REGTEST_BTC_EXPLORER"
    ESPLORA_URL="http://localhost:3002/regtest/api"
    MEMPOOL_WS="false"
    ;;
  sui-testnet)
    SOLANA_RPC=""
    BTC_NETWORK="${BTC_NETWORK:-testnet4}"
    BACKEND_URL="${BACKEND_URL:-}"
    TRACKER_API_PORT="${TRACKER_API_PORT:-3001}"
    BTC_EXPLORER="https://mempool.space/testnet4"
    ESPLORA_URL="https://mempool.space/testnet4/api"
    MEMPOOL_WS="false"
    ;;
  sui-regtest)
    SOLANA_RPC=""
    BTC_NETWORK="${BTC_NETWORK:-regtest}"
    BACKEND_URL="${BACKEND_URL:-https://api-hybrid.utxopia.com}"
    TRACKER_API_PORT="${TRACKER_API_PORT:-3001}"
    BTC_EXPLORER="$PUBLIC_REGTEST_BTC_EXPLORER"
    ESPLORA_URL="http://localhost:3002/regtest/api"
    MEMPOOL_WS="false"
    ;;
esac

echo "Program ID:    $PROGRAM_ID"
echo "zkBTC Mint:    $ZKBTC_MINT"
echo "BTC LC:        $BTC_LC_ID"
echo "Group Pubkey:  ${GROUP_PUBKEY:0:16}..."
if [ "$NETWORK" = "sui-testnet" ] || [ "$NETWORK" = "sui-regtest" ]; then
  echo "Sui Package:   $SUI_PACKAGE_ID"
  echo "Sui Relayer:   $SUI_RELAYER_ADDRESS"
  GENERATED_RELAYER_KEYPAIR=""
  GENERATED_BACKEND_API_KEY="localnet-dev-key"
else
  GENERATED_RELAYER_KEYPAIR="\${RELAYER_KEYPAIR:?Set RELAYER_KEYPAIR env var}"
  GENERATED_BACKEND_API_KEY="\${BACKEND_API_KEY:?Set BACKEND_API_KEY env var}"
fi
echo ""

# ─── 1. Generate backend/.env.{network} ──────────────────────────────────────

BACKEND_ENV="$ROOT/backend/.env.$NETWORK"
cat > "$BACKEND_ENV" << EOF
# UTXOpia Backend — $NETWORK (auto-generated by sync-env.sh)
# Source: $STATE_FILE
# Re-generate: UTXOPIA_NETWORK=$NETWORK ./scripts/sync-env.sh

# ─── Solana ──────────────────────────────────────────────────────────────────
UTXOPIA_PROGRAM_ID=$PROGRAM_ID
UTXOPIA_ZKBTC_MINT=$ZKBTC_MINT
UTXOPIA_NETWORK=$NETWORK
UTXOPIA_SOLANA_RPC=$SOLANA_RPC
SOLANA_RPC_URL=$SOLANA_RPC
BTC_LIGHT_CLIENT_PROGRAM_ID=$BTC_LC_ID

# ─── Bitcoin ─────────────────────────────────────────────────────────────────
UTXOPIA_BITCOIN_NETWORK=$BTC_NETWORK
UTXOPIA_BITCOIN_RPC=$ESPLORA_URL
ESPLORA_URL=$ESPLORA_URL
MEMPOOL_API_URL=$ESPLORA_URL
POOL_RECEIVE_ADDRESS=$POOL_BTC_ADDR

# ─── Signing mode (driven by state JSON's "signingMode" field) ──────────────
UTXOPIA_SIGNING_MODE=$SIGNING_MODE
UTXOPIA_DEPOSIT_MODE=$DEPOSIT_MODE

# ─── Ika dWallet (custody for v2 — primary signing path) ────────────────────
UTXOPIA_IKA_PROGRAM_ID=$IKA_PROGRAM_ID
UTXOPIA_IKA_GRPC_ENDPOINT=$IKA_GRPC_ENDPOINT
UTXOPIA_IKA_DWALLET=$IKA_DWALLET
UTXOPIA_IKA_DWALLET_XONLY_PUBKEY=$IKA_DWALLET_XONLY_PUBKEY
UTXOPIA_IKA_CPI_AUTHORITY_BUMP=$IKA_CPI_AUTHORITY_BUMP

# ─── Sui testnet POC ─────────────────────────────────────────────────────────
UTXOPIA_SUI_NETWORK=$SUI_NETWORK
UTXOPIA_SUI_RPC_URL=$SUI_RPC_URL
UTXOPIA_SUI_STATE_FILE=$ROOT/chains/sui/sui-poc-state.json
UTXOPIA_SUI_PACKAGE_ID=$SUI_PACKAGE_ID
UTXOPIA_SUI_POOL_ID=$SUI_POOL_ID
UTXOPIA_SUI_POOL_INITIAL_SHARED_VERSION=$SUI_POOL_VERSION
UTXOPIA_SUI_BTC_DEPOSIT_REGISTRY_ID=$SUI_BTC_DEPOSIT_REGISTRY_ID
UTXOPIA_SUI_BTC_DEPOSIT_REGISTRY_INITIAL_SHARED_VERSION=$SUI_BTC_DEPOSIT_REGISTRY_VERSION
UTXOPIA_SUI_NULLIFIER_REGISTRY_ID=$SUI_NULLIFIER_REGISTRY_ID
UTXOPIA_SUI_NULLIFIER_REGISTRY_INITIAL_SHARED_VERSION=$SUI_NULLIFIER_REGISTRY_VERSION
UTXOPIA_SUI_REDEMPTION_QUEUE_ID=$SUI_REDEMPTION_QUEUE_ID
UTXOPIA_SUI_REDEMPTION_QUEUE_INITIAL_SHARED_VERSION=$SUI_REDEMPTION_QUEUE_VERSION
UTXOPIA_SUI_REDEMPTION_CAP_ID=$SUI_REDEMPTION_CAP_ID
UTXOPIA_SUI_REDEMPTION_CAP_VERSION=$SUI_REDEMPTION_CAP_VERSION
UTXOPIA_SUI_REDEMPTION_CAP_DIGEST=$SUI_REDEMPTION_CAP_DIGEST
UTXOPIA_SUI_VERIFYING_KEY_REGISTRY_ID=$SUI_VERIFYING_KEY_REGISTRY_ID
UTXOPIA_SUI_VERIFYING_KEY_REGISTRY_INITIAL_SHARED_VERSION=$SUI_VERIFYING_KEY_REGISTRY_VERSION
UTXOPIA_SUI_RELAYER_ADDRESS=$SUI_RELAYER_ADDRESS
UTXOPIA_SUI_RELAYER_KEYPAIR_PATH=$SUI_RELAYER_KEYPAIR_PATH
UTXOPIA_SUI_RELAYER_KEY_SCHEME=$SUI_RELAYER_KEY_SCHEME
UTXOPIA_SUINS_PARENT_NFT_ID=$SUI_SUINS_PARENT_NFT_ID
UTXOPIA_SUI_GAS_BUDGET=$SUI_GAS_BUDGET
UTXOPIA_SUI_WITHDRAW_SIGNER_MODE=$SIGNING_MODE
UTXOPIA_SUI_IKA_NETWORK=$SUI_IKA_NETWORK
UTXOPIA_SUI_IKA_PACKAGE=$SUI_IKA_PACKAGE
UTXOPIA_SUI_IKA_COMMON_PACKAGE=$SUI_IKA_COMMON_PACKAGE
UTXOPIA_SUI_IKA_SYSTEM_PACKAGE=$SUI_IKA_SYSTEM_PACKAGE
UTXOPIA_SUI_IKA_DWALLET_2PC_MPC_PACKAGE=$SUI_IKA_DWALLET_2PC_MPC_PACKAGE
UTXOPIA_SUI_IKA_SYSTEM_OBJECT_ID=$SUI_IKA_SYSTEM_OBJECT_ID
UTXOPIA_SUI_IKA_SYSTEM_OBJECT_INITIAL_SHARED_VERSION=$SUI_IKA_SYSTEM_OBJECT_VERSION
UTXOPIA_SUI_IKA_DWALLET_COORDINATOR_ID=$SUI_IKA_DWALLET_COORDINATOR_ID
UTXOPIA_SUI_IKA_DWALLET_COORDINATOR_INITIAL_SHARED_VERSION=$SUI_IKA_DWALLET_COORDINATOR_VERSION
UTXOPIA_SUI_IKA_DWALLET_ID=$SUI_IKA_DWALLET_ID
UTXOPIA_SUI_IKA_DWALLET_CAP_ID=$SUI_IKA_DWALLET_CAP_ID
UTXOPIA_SUI_IKA_NETWORK_ENCRYPTION_KEY_ID=$SUI_IKA_NETWORK_ENCRYPTION_KEY_ID
UTXOPIA_SUI_IKA_COIN_ID=$SUI_IKA_COIN_ID
UTXOPIA_SUI_IKA_SUI_COIN_ID=$SUI_IKA_SUI_COIN_ID

# ─── Tracker & Indexer ───────────────────────────────────────────────────────
TRACKER_API_PORT=$TRACKER_API_PORT
DEPOSIT_DB_PATH=data/deposits.db
INDEXER_DB_PATH=data/events.db
INDEXER_POLL_INTERVAL_SECS=10
UTXOPIA_DEMO_MODE=1

# ─── Keypairs ────────────────────────────────────────────────────────────────
VERIFIER_KEYPAIR=verifier-keypair.json
RELAYER_KEYPAIR=$GENERATED_RELAYER_KEYPAIR

# ─── WebSocket & Header Relay ────────────────────────────────────────────────
MEMPOOL_WS_ENABLED=$MEMPOOL_WS
MEMPOOL_WS_URL=wss://mempool.space/testnet4/api/v1/ws
HEADER_RELAY_ENABLED=$MEMPOOL_WS
HEADER_BATCH_SIZE=5

# ─── Fees ────────────────────────────────────────────────────────────────────
RELAYER_FEE_SATS=500
UTXOPIA_BROADCAST_MODE=real

# ─── API Auth ────────────────────────────────────────────────────────────────
BACKEND_API_KEY=$GENERATED_BACKEND_API_KEY

# ─── Allowed Origins ─────────────────────────────────────────────────────────
ALLOWED_ORIGIN=http://localhost:3000

# ─── Logging ─────────────────────────────────────────────────────────────────
RUST_LOG=info,zkbtc=debug
EOF

echo "✓ Generated $BACKEND_ENV"
ln -sf ".env.$NETWORK" "$ROOT/backend/.env"
echo "✓ Symlinked backend/.env → .env.$NETWORK"

# ─── 2. Generate web/.env.{network} ──────────────────────────────────────────

FRONTEND_ENV="$ROOT/web/.env.$NETWORK"
cat > "$FRONTEND_ENV" << EOF
# UTXOpia Frontend — $NETWORK (auto-generated by sync-env.sh)
# Source: $STATE_FILE
# Re-generate: UTXOPIA_NETWORK=$NETWORK ./scripts/sync-env.sh

NEXT_PUBLIC_NETWORK=$NETWORK
NEXT_PUBLIC_SOLANA_RPC_URL=$SOLANA_RPC
NEXT_PUBLIC_BTC_NETWORK=$BTC_NETWORK
NEXT_PUBLIC_UTXOPIA_PROGRAM_ID=$PROGRAM_ID
NEXT_PUBLIC_ZKBTC_MINT=$ZKBTC_MINT
NEXT_PUBLIC_SUI_RPC_URL=$SUI_RPC_URL
UTXOPIA_SUI_RPC_URL=$SUI_RPC_URL
NEXT_PUBLIC_SUI_PACKAGE_ID=$SUI_PACKAGE_ID
NEXT_PUBLIC_SUI_POOL_ID=$SUI_POOL_ID
NEXT_PUBLIC_SUI_BTC_DEPOSIT_REGISTRY_ID=$SUI_BTC_DEPOSIT_REGISTRY_ID
NEXT_PUBLIC_SUI_NULLIFIER_REGISTRY_ID=$SUI_NULLIFIER_REGISTRY_ID
NEXT_PUBLIC_SUI_REDEMPTION_QUEUE_ID=$SUI_REDEMPTION_QUEUE_ID
NEXT_PUBLIC_SUI_REDEMPTION_CAP_ID=$SUI_REDEMPTION_CAP_ID
NEXT_PUBLIC_SUI_VERIFYING_KEY_REGISTRY_ID=$SUI_VERIFYING_KEY_REGISTRY_ID
NEXT_PUBLIC_SUI_RELAYER_ADDRESS=$SUI_RELAYER_ADDRESS
UTXOPIA_SUI_RELAYER_ADDRESS=$SUI_RELAYER_ADDRESS
UTXOPIA_SUI_RELAYER_KEYPAIR_PATH=$SUI_RELAYER_KEYPAIR_PATH
UTXOPIA_SUI_RELAYER_KEY_SCHEME=$SUI_RELAYER_KEY_SCHEME
UTXOPIA_SUINS_PARENT_NFT_ID=$SUI_SUINS_PARENT_NFT_ID
UTXOPIA_SUI_GAS_BUDGET=$SUI_GAS_BUDGET
NEXT_PUBLIC_SUI_WITHDRAW_SIGNER_MODE=$SIGNING_MODE
NEXT_PUBLIC_SUI_IKA_NETWORK=$SUI_IKA_NETWORK
NEXT_PUBLIC_SUI_IKA_PACKAGE=$SUI_IKA_PACKAGE
NEXT_PUBLIC_SUI_IKA_SYSTEM_OBJECT_ID=$SUI_IKA_SYSTEM_OBJECT_ID
NEXT_PUBLIC_SUI_IKA_DWALLET_COORDINATOR_ID=$SUI_IKA_DWALLET_COORDINATOR_ID
EOF

[ -n "$USDC_MINT" ] && echo "NEXT_PUBLIC_USDC_MINT=$USDC_MINT" >> "$FRONTEND_ENV"
[ -n "$USDT_MINT" ] && echo "NEXT_PUBLIC_USDT_MINT=$USDT_MINT" >> "$FRONTEND_ENV"
[ -n "$WSOL_MINT" ] && echo "NEXT_PUBLIC_WSOL_MINT=$WSOL_MINT" >> "$FRONTEND_ENV"
[ -n "$JUPUSD_MINT" ] && echo "NEXT_PUBLIC_JUPUSD_MINT=$JUPUSD_MINT" >> "$FRONTEND_ENV"

cat >> "$FRONTEND_ENV" << EOF

# Backend API
BACKEND_API_URL=$BACKEND_URL
NEXT_PUBLIC_BACKEND_API_URL=$BACKEND_URL
BACKEND_API_KEY=$([ "$NETWORK" = "devnet" ] && printf '%s' "utxopia-backend-2026" || printf '%s' "localnet-dev-key")
EOF

echo "✓ Generated $FRONTEND_ENV"
ln -sf ".env.$NETWORK" "$ROOT/web/.env.local"
echo "✓ Symlinked web/.env.local → .env.$NETWORK"

# ─── 3. Generate web/src/lib/networks.json ───────────────────────────────────
#
# This is the frontend's runtime config. We update ONLY the current network's
# section, preserving other networks' config.

NETWORKS_JSON="$ROOT/web/src/lib/networks.json"

# Build the network block with python3 (no jq needed)
python3 << PYEOF
import json, os

networks_path = "$NETWORKS_JSON"

# Load existing networks.json
if os.path.exists(networks_path):
    with open(networks_path) as f:
        networks = json.load(f)
else:
    networks = {}

network = "$NETWORK"
sui_config = None
if network in ("sui-testnet", "sui-regtest"):
    sui_config = {
        "rpcUrl": "$SUI_RPC_URL",
        "explorerUrl": "https://suiexplorer.com",
        "packageId": "$SUI_PACKAGE_ID",
        "pool": {
            "objectId": "$SUI_POOL_ID",
            "initialSharedVersion": "$SUI_POOL_VERSION",
        },
        "btcDepositRegistry": {
            "objectId": "$SUI_BTC_DEPOSIT_REGISTRY_ID",
            "initialSharedVersion": "$SUI_BTC_DEPOSIT_REGISTRY_VERSION",
        },
        "nullifierRegistry": {
            "objectId": "$SUI_NULLIFIER_REGISTRY_ID",
            "initialSharedVersion": "$SUI_NULLIFIER_REGISTRY_VERSION",
        },
        "redemptionQueue": {
            "objectId": "$SUI_REDEMPTION_QUEUE_ID",
            "initialSharedVersion": "$SUI_REDEMPTION_QUEUE_VERSION",
        },
        "redemptionCap": {
            "objectId": "$SUI_REDEMPTION_CAP_ID",
            "version": "$SUI_REDEMPTION_CAP_VERSION",
            "digest": "$SUI_REDEMPTION_CAP_DIGEST",
        },
        "verifyingKeyRegistry": {
            "objectId": "$SUI_VERIFYING_KEY_REGISTRY_ID",
            "initialSharedVersion": "$SUI_VERIFYING_KEY_REGISTRY_VERSION",
        },
        "relayer": {
            "address": "$SUI_RELAYER_ADDRESS",
        },
        "signing": {
            "btcWithdrawal": "$SIGNING_MODE",
        },
        "ika": {
            "network": "$SUI_IKA_NETWORK",
            "packageId": "$SUI_IKA_PACKAGE",
            "commonPackageId": "$SUI_IKA_COMMON_PACKAGE",
            "systemPackageId": "$SUI_IKA_SYSTEM_PACKAGE",
            "dwallet2pcMpcPackageId": "$SUI_IKA_DWALLET_2PC_MPC_PACKAGE",
            "systemObject": {
                "objectId": "$SUI_IKA_SYSTEM_OBJECT_ID",
                "initialSharedVersion": "$SUI_IKA_SYSTEM_OBJECT_VERSION",
            },
            "dwalletCoordinator": {
                "objectId": "$SUI_IKA_DWALLET_COORDINATOR_ID",
                "initialSharedVersion": "$SUI_IKA_DWALLET_COORDINATOR_VERSION",
            },
            "dWalletId": "$SUI_IKA_DWALLET_ID",
            "dWalletCapObjectId": "$SUI_IKA_DWALLET_CAP_ID",
            "networkEncryptionKeyId": "$SUI_IKA_NETWORK_ENCRYPTION_KEY_ID",
        },
    }

# Update the current network section
network_block = {
    "chain": "sui" if network in ("sui-testnet", "sui-regtest") else "solana",
    "solana": {
        "rpcUrl": "$SOLANA_RPC",
        "utxopiaProgramId": "$PROGRAM_ID",
        "btcLightClientId": "$BTC_LC_ID",
        "chadbufferId": "C5RpjtTMFXKVZCtXSzKXD4CDNTaWBg3dVeMfYvjZYHDF"
    },
    "tokens": {
        "zkbtcMint": "$ZKBTC_MINT",
        "usdcMint": "$USDC_MINT",
        "usdtMint": "$USDT_MINT",
        "wsolMint": "$WSOL_MINT",
        "jupusdMint": "$JUPUSD_MINT"
    },
    "bitcoin": {
        "network": "$BTC_NETWORK",
        "poolAddress": "$POOL_BTC_ADDR",
        "groupPubkey": "$GROUP_PUBKEY",
        "depositMode": "$DEPOSIT_MODE",
        "explorerUrl": "$BTC_EXPLORER"
    },
    "ika": {
        "programId": "$IKA_PROGRAM_ID",
        "grpcEndpoint": "$IKA_GRPC_ENDPOINT",
        "dwallet": "$IKA_DWALLET",
        "dwalletXOnlyPubkey": "$IKA_DWALLET_XONLY_PUBKEY"
    },
    "backend": {
        "url": "$BACKEND_URL"
    }
}

if sui_config:
    network_block["sui"] = sui_config
    state_vk = json.load(open("$STATE_FILE")).get("vk", {})
    if state_vk:
        network_block["sui"]["vk"] = {
            name: {
                "nInputs": vk.get("nInputs"),
                "nOutputs": vk.get("nOutputs"),
                "nPublic": vk.get("nPublic"),
                "vkHash": vk.get("vkHash"),
                **({"registerTxDigest": vk["registerTxDigest"]} if vk.get("registerTxDigest") else {}),
            }
            for name, vk in state_vk.items()
        }

networks[network] = network_block

with open(networks_path, "w") as f:
    json.dump(networks, f, indent=2)
    f.write("\n")

print(f"✓ Updated {networks_path} [{network}]")
PYEOF

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "=== Config Sync Complete ==="
echo "Generated from: $STATE_FILE"
echo ""
echo "Files updated:"
echo "  1. $BACKEND_ENV"
echo "  2. $FRONTEND_ENV"
echo "  3. $NETWORKS_JSON"
echo ""
echo "To switch networks:"
echo "  UTXOPIA_NETWORK=devnet ./scripts/sync-env.sh"
