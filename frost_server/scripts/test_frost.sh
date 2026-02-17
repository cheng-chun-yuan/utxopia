#!/bin/bash
# Test script for FROST threshold signing
# Usage: ./scripts/test_frost.sh [start|test|sign|address]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASSWORD="${FROST_KEY_PASSWORD:-test}"

# Group public key (x-only, 32 bytes hex)
GROUP_PUBKEY=$(cat "$ROOT_DIR/config/group_pubkey.txt")

cd "$ROOT_DIR"

start_signers() {
    echo "Starting FROST signers..."

    # Check if already running
    if curl -s http://localhost:9001/health > /dev/null 2>&1; then
        echo "Signers appear to be already running"
        return
    fi

    echo "Building FROST server..."
    cargo build --release

    echo "Starting signer 1 on port 9001..."
    FROST_KEY_PASSWORD="$PASSWORD" ./target/release/frost-server run --id 1 --bind 0.0.0.0:9001 &

    echo "Starting signer 2 on port 9002..."
    FROST_KEY_PASSWORD="$PASSWORD" ./target/release/frost-server run --id 2 --bind 0.0.0.0:9002 &

    echo "Starting signer 3 on port 9003..."
    FROST_KEY_PASSWORD="$PASSWORD" ./target/release/frost-server run --id 3 --bind 0.0.0.0:9003 &

    echo "Waiting for signers to start..."
    sleep 3

    # Check health
    for port in 9001 9002 9003; do
        if curl -s "http://localhost:$port/health" | grep -q "ok"; then
            echo "  Signer on port $port: OK"
        else
            echo "  Signer on port $port: FAILED"
        fi
    done
}

stop_signers() {
    echo "Stopping FROST signers..."
    pkill -f "frost-server run" || true
    echo "Signers stopped"
}

test_health() {
    echo "Testing health endpoints..."
    echo ""

    for port in 9001 9002 9003; do
        echo "Signer on port $port:"
        curl -s "http://localhost:$port/health" | python3 -m json.tool 2>/dev/null || echo "  Not responding"
        echo ""
    done
}

test_signing() {
    echo "Testing FROST signing flow (2-of-3 threshold)..."
    echo ""

    SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    SIGHASH="4242424242424242424242424242424242424242424242424242424242424242"

    echo "Session ID: $SESSION_ID"
    echo "Sighash: $SIGHASH"
    echo ""

    # Round 1: Collect commitments from signers 1 and 2
    echo "=== Round 1: Collecting commitments ==="

    ROUND1_1=$(curl -s -X POST "http://localhost:9001/round1" \
        -H "Content-Type: application/json" \
        -d "{\"session_id\": \"$SESSION_ID\", \"sighash\": \"$SIGHASH\"}")
    echo "Signer 1 response: ${ROUND1_1:0:100}..."

    ROUND1_2=$(curl -s -X POST "http://localhost:9002/round1" \
        -H "Content-Type: application/json" \
        -d "{\"session_id\": \"$SESSION_ID\", \"sighash\": \"$SIGHASH\"}")
    echo "Signer 2 response: ${ROUND1_2:0:100}..."

    # Extract commitments and identifiers
    COMMIT_1=$(echo "$ROUND1_1" | python3 -c "import sys, json; print(json.load(sys.stdin)['commitment'])")
    COMMIT_2=$(echo "$ROUND1_2" | python3 -c "import sys, json; print(json.load(sys.stdin)['commitment'])")
    IDENT_1=$(echo "$ROUND1_1" | python3 -c "import sys, json; print(json.load(sys.stdin)['frost_identifier'])")
    IDENT_2=$(echo "$ROUND1_2" | python3 -c "import sys, json; print(json.load(sys.stdin)['frost_identifier'])")

    echo ""
    echo "=== Round 2: Collecting signature shares ==="

    # Round 2: Get signature shares
    ROUND2_1=$(curl -s -X POST "http://localhost:9001/round2" \
        -H "Content-Type: application/json" \
        -d "{
            \"session_id\": \"$SESSION_ID\",
            \"sighash\": \"$SIGHASH\",
            \"commitments\": {\"1\": \"$COMMIT_1\", \"2\": \"$COMMIT_2\"},
            \"identifier_map\": {\"1\": \"$IDENT_1\", \"2\": \"$IDENT_2\"}
        }")
    echo "Signer 1 share: ${ROUND2_1:0:100}..."

    ROUND2_2=$(curl -s -X POST "http://localhost:9002/round2" \
        -H "Content-Type: application/json" \
        -d "{
            \"session_id\": \"$SESSION_ID\",
            \"sighash\": \"$SIGHASH\",
            \"commitments\": {\"1\": \"$COMMIT_1\", \"2\": \"$COMMIT_2\"},
            \"identifier_map\": {\"1\": \"$IDENT_1\", \"2\": \"$IDENT_2\"}
        }")
    echo "Signer 2 share: ${ROUND2_2:0:100}..."

    echo ""
    echo "Signing test complete!"
    echo "In production, these shares would be aggregated into a valid Schnorr signature."
}

show_address() {
    echo "FROST Group Configuration"
    echo "========================="
    echo ""
    echo "Group Public Key (x-only): $GROUP_PUBKEY"
    echo ""
    echo "Testnet Taproot Address:"
    echo "  tb1p${GROUP_PUBKEY:0:40}..."
    echo ""
    echo "To get the full bech32m address, use bitcoin-cli or the SDK:"
    echo "  bitcoin-cli -testnet getaddressinfo <address>"
    echo ""
    echo "Or derive in Node.js:"
    echo "  const { payments, networks } = require('bitcoinjs-lib');"
    echo "  const pubkey = Buffer.from('$GROUP_PUBKEY', 'hex');"
    echo "  const { address } = payments.p2tr({ internalPubkey: pubkey, network: networks.testnet });"
}

case "${1:-test}" in
    start)
        start_signers
        ;;
    stop)
        stop_signers
        ;;
    test)
        test_health
        ;;
    sign)
        test_signing
        ;;
    address)
        show_address
        ;;
    all)
        start_signers
        sleep 2
        test_health
        test_signing
        show_address
        ;;
    *)
        echo "Usage: $0 [start|stop|test|sign|address|all]"
        echo ""
        echo "Commands:"
        echo "  start   - Start all 3 FROST signers"
        echo "  stop    - Stop all signers"
        echo "  test    - Test health endpoints"
        echo "  sign    - Run full signing test"
        echo "  address - Show Taproot deposit address"
        echo "  all     - Run all tests"
        ;;
esac
