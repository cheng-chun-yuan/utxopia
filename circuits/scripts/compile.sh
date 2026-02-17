#!/bin/bash
# Compile all circom circuits
# Requires circom v2.1.0+ installed: https://docs.circom.io/getting-started/installation/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/build"
CIRCOM_DIR="$ROOT_DIR/circom"

CIRCUITS=(
  "claim"
  "spend_split"
  "spend_partial_public"
  "pool_deposit"
  "pool_withdraw"
  "pool_claim_yield"
)

echo "=== Compiling circom circuits ==="
echo "Build directory: $BUILD_DIR"

for circuit in "${CIRCUITS[@]}"; do
  echo ""
  echo "--- Compiling: $circuit ---"

  CIRCUIT_BUILD="$BUILD_DIR/$circuit"
  mkdir -p "$CIRCUIT_BUILD"

  circom "$CIRCOM_DIR/$circuit.circom" \
    --r1cs \
    --wasm \
    --sym \
    -o "$CIRCUIT_BUILD" \
    -l "$ROOT_DIR/node_modules"

  echo "  R1CS: $CIRCUIT_BUILD/${circuit}.r1cs"
  echo "  WASM: $CIRCUIT_BUILD/${circuit}_js/${circuit}.wasm"
  echo "  SYM:  $CIRCUIT_BUILD/${circuit}.sym"
done

echo ""
echo "=== All circuits compiled successfully ==="
