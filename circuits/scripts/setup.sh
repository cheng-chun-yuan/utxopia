#!/bin/bash
# Groth16 trusted setup for JoinSplit circuit variants
# Uses Powers of Tau ceremony + circuit-specific Phase 2
#
# Usage:
#   bash scripts/setup.sh             # Setup tier-1 (default)
#   bash scripts/setup.sh --tier1     # Same as default
#   bash scripts/setup.sh --tier2     # Tier-1 + additional variants
#   bash scripts/setup.sh --all       # All compiled variants
#
# Requires: npx snarkjs

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/build"
PTAU_DIR="$BUILD_DIR/ptau"

TIER="${1:---tier1}"

# Define tier variants (must match compile.sh)
TIER1_CIRCUITS=("joinsplit_1x1" "joinsplit_1x2" "joinsplit_2x1" "joinsplit_2x2")
TIER2_CIRCUITS=("${TIER1_CIRCUITS[@]}" "joinsplit_1x3" "joinsplit_3x1" "joinsplit_2x3" "joinsplit_3x2" "joinsplit_1x4" "joinsplit_4x1")

case "$TIER" in
  --tier1)
    CIRCUITS=("${TIER1_CIRCUITS[@]}")
    ;;
  --tier2)
    CIRCUITS=("${TIER2_CIRCUITS[@]}")
    ;;
  --all)
    # Discover all compiled variants (those with .r1cs files)
    CIRCUITS=()
    for d in "$BUILD_DIR"/joinsplit_*/; do
      [ -d "$d" ] || continue
      name=$(basename "$d")
      if [ -f "$d/${name}.r1cs" ]; then
        CIRCUITS+=("$name")
      fi
    done
    ;;
  *)
    echo "Unknown tier: $TIER"
    echo "Usage: bash scripts/setup.sh [--tier1 | --tier2 | --all]"
    exit 1
    ;;
esac

# Powers of Tau size (2^18 = 262144 constraints — EdDSA-Poseidon adds ~5K constraints)
PTAU_POWER=18

echo "=== Groth16 Trusted Setup for ${#CIRCUITS[@]} variants ($TIER) ==="

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
echo "=== Trusted setup complete for ${#CIRCUITS[@]} variants ==="
echo ""
echo "Next steps:"
echo "  1. Verify keys: npx snarkjs zkey verify build/<circuit>/<circuit>.r1cs $PTAU_FILE build/<circuit>/<circuit>.zkey"
echo "  2. Export VK for Rust: node scripts/export-vk-rust.js <variant_name>"
echo "  3. Copy to SDK: cp -r build/joinsplit_* ../sdk/circuits/"
