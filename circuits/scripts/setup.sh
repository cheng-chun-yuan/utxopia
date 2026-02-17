#!/bin/bash
# Groth16 trusted setup for all circuits
# Uses Powers of Tau ceremony + circuit-specific Phase 2
#
# Requires: npx snarkjs (bun add -g npx snarkjs)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/build"
PTAU_DIR="$BUILD_DIR/ptau"

CIRCUITS=(
  "claim"
  "spend_split"
  "spend_partial_public"
  "pool_deposit"
  "pool_withdraw"
  "pool_claim_yield"
)

# Powers of Tau size (2^16 = 65536 constraints should be sufficient)
PTAU_POWER=16

echo "=== Groth16 Trusted Setup ==="

# Phase 1: Powers of Tau (shared across all circuits)
mkdir -p "$PTAU_DIR"
PTAU_FILE="$PTAU_DIR/pot${PTAU_POWER}_final.ptau"

if [ ! -f "$PTAU_FILE" ]; then
  echo ""
  echo "--- Phase 1: Powers of Tau (2^${PTAU_POWER}) ---"

  npx snarkjs powersoftau new bn128 $PTAU_POWER "$PTAU_DIR/pot${PTAU_POWER}_0000.ptau" -v
  npx snarkjs powersoftau contribute "$PTAU_DIR/pot${PTAU_POWER}_0000.ptau" "$PTAU_DIR/pot${PTAU_POWER}_0001.ptau" --name="First contribution" -v -e="random entropy for setup"
  npx snarkjs powersoftau prepare phase2 "$PTAU_DIR/pot${PTAU_POWER}_0001.ptau" "$PTAU_FILE" -v

  # Cleanup intermediate files
  rm -f "$PTAU_DIR/pot${PTAU_POWER}_0000.ptau" "$PTAU_DIR/pot${PTAU_POWER}_0001.ptau"

  echo "  PTAU: $PTAU_FILE"
else
  echo "Using existing PTAU: $PTAU_FILE"
fi

# Phase 2: Circuit-specific setup
for circuit in "${CIRCUITS[@]}"; do
  echo ""
  echo "--- Phase 2: $circuit ---"

  R1CS="$BUILD_DIR/$circuit/${circuit}.r1cs"
  ZKEY="$BUILD_DIR/$circuit/${circuit}.zkey"
  VKEY="$BUILD_DIR/$circuit/${circuit}.vkey.json"

  if [ ! -f "$R1CS" ]; then
    echo "  SKIP: R1CS not found (run compile.sh first)"
    continue
  fi

  # Generate zkey
  npx snarkjs groth16 setup "$R1CS" "$PTAU_FILE" "$BUILD_DIR/$circuit/${circuit}_0000.zkey"
  npx snarkjs zkey contribute "$BUILD_DIR/$circuit/${circuit}_0000.zkey" "$ZKEY" --name="Circuit contribution" -v -e="random entropy for ${circuit}"

  # Export verification key
  npx snarkjs zkey export verificationkey "$ZKEY" "$VKEY"

  # Cleanup intermediate
  rm -f "$BUILD_DIR/$circuit/${circuit}_0000.zkey"

  echo "  ZKEY: $ZKEY"
  echo "  VKEY: $VKEY"
done

echo ""
echo "=== Trusted setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Verify keys: npx snarkjs zkey verify build/<circuit>/<circuit>.r1cs $PTAU_FILE build/<circuit>/<circuit>.zkey"
echo "  2. Generate proof: npx snarkjs groth16 fullprove input.json build/<circuit>/<circuit>_js/<circuit>.wasm build/<circuit>/<circuit>.zkey proof.json public.json"
