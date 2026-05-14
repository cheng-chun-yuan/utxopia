#!/bin/bash
# Compile + single-party Groth16 setup for auxiliary circuits
# (proof_of_innocence, ownership, range_sum, range_sum_4, range_sum_16).
#
# These don't follow the joinsplit_NxM tier structure, so they get their own
# helper. Single-party "dev" setup — for production these need a real MPC
# Powers-of-Tau ceremony rather than the local contribute step below.
#
# Usage:
#   bash scripts/build-aux.sh range_sum_4
#   bash scripts/build-aux.sh range_sum_16
#   bash scripts/build-aux.sh ownership
#   bash scripts/build-aux.sh proof_of_innocence
#
# Requires: circom 2.x, npx snarkjs, and circuits/build/ptau/powersOfTau28_hez_final_18.ptau
# (the existing ptau file is enough for circuits up to 2^18 constraints).

set -e

if [ $# -lt 1 ]; then
  echo "Usage: bash scripts/build-aux.sh <circuit_name>"
  echo "Valid circuits: proof_of_innocence, ownership, range_sum, range_sum_4, range_sum_16"
  exit 1
fi

CIRCUIT="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CIRCOM_FILE="$ROOT_DIR/circom/${CIRCUIT}.circom"
BUILD_DIR="$ROOT_DIR/build/${CIRCUIT}"
PTAU_FILE="$ROOT_DIR/build/ptau/powersOfTau28_hez_final_18.ptau"

if [ ! -f "$CIRCOM_FILE" ]; then
  echo "Error: source circuit not found at $CIRCOM_FILE"
  exit 1
fi
if [ ! -f "$PTAU_FILE" ]; then
  echo "Error: ptau file not found at $PTAU_FILE"
  echo "Hint: download via curl -L -o $PTAU_FILE https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_18.ptau"
  exit 1
fi

command -v circom >/dev/null 2>&1 || { echo "Error: circom not installed"; exit 1; }
npx snarkjs 2>&1 | grep -q "^snarkjs@" || { echo "Error: snarkjs not installed (npm install -g snarkjs)"; exit 1; }

mkdir -p "$BUILD_DIR"

echo "=== ${CIRCUIT} ==="
echo ""
echo "--- 1/4 Compile circom -> r1cs + wasm ---"
circom "$CIRCOM_FILE" \
  --r1cs --wasm --sym \
  -l "$ROOT_DIR/node_modules" \
  -o "$BUILD_DIR"

R1CS="$BUILD_DIR/${CIRCUIT}.r1cs"
WASM="$BUILD_DIR/${CIRCUIT}_js/${CIRCUIT}.wasm"
ZKEY_INIT="$BUILD_DIR/${CIRCUIT}_0000.zkey"
ZKEY="$BUILD_DIR/${CIRCUIT}.zkey"
VKEY="$BUILD_DIR/${CIRCUIT}.vkey.json"

echo ""
echo "--- 2/4 groth16 setup ---"
npx snarkjs groth16 setup "$R1CS" "$PTAU_FILE" "$ZKEY_INIT"

echo ""
echo "--- 3/4 zkey contribute (single-party, dev-only) ---"
npx snarkjs zkey contribute "$ZKEY_INIT" "$ZKEY" \
  --name="${CIRCUIT} contribution" \
  -v \
  -e="random entropy for ${CIRCUIT} $(date +%s)"

echo ""
echo "--- 4/4 export verification key ---"
npx snarkjs zkey export verificationkey "$ZKEY" "$VKEY"

rm -f "$ZKEY_INIT"

echo ""
echo "=== ${CIRCUIT} build complete ==="
echo "  R1CS: $R1CS"
echo "  WASM: $WASM"
echo "  ZKEY: $ZKEY"
echo "  VKEY: $VKEY"
echo ""
echo "Next: regenerate the Rust VK constants if this circuit is verified on-chain:"
echo "  node scripts/export-vk-rust.js ${CIRCUIT}"
