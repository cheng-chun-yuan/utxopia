#!/bin/bash
# Compile JoinSplit circom circuit variants
# Requires circom v2.1.0+ installed: https://docs.circom.io/getting-started/installation/
#
# Usage:
#   bash scripts/compile.sh             # Compile tier-1 (default: 1x1, 1x2, 2x1, 2x2)
#   bash scripts/compile.sh --tier1     # Same as default
#   bash scripts/compile.sh --tier2     # Tier-1 + 1x3, 3x1, 2x3, 3x2, 1x4, 4x1
#   bash scripts/compile.sh --all       # All 91 variants

set -e

# Pre-flight checks
command -v circom >/dev/null 2>&1 || { echo "Error: circom not installed. See https://docs.circom.io/getting-started/installation/"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/build"
GENERATED_DIR="$ROOT_DIR/circom/generated"

TIER="${1:---tier1}"

# Shared tier definitions
source "$SCRIPT_DIR/tiers.sh"

case "$TIER" in
  --tier1)
    CIRCUITS=("${TIER1_CIRCUITS[@]}")
    ;;
  --tier2)
    CIRCUITS=("${TIER2_CIRCUITS[@]}")
    ;;
  --all)
    # Discover all generated variant files
    CIRCUITS=()
    for f in "$GENERATED_DIR"/joinsplit_*.circom; do
      [ -f "$f" ] || continue
      name=$(basename "$f" .circom)
      CIRCUITS+=("$name")
    done
    ;;
  *)
    echo "Unknown tier: $TIER"
    echo "Usage: bash scripts/compile.sh [--tier1 | --tier2 | --all]"
    exit 1
    ;;
esac

# Ensure generated variants exist
if [ ! -d "$GENERATED_DIR" ] || [ -z "$(ls -A "$GENERATED_DIR" 2>/dev/null)" ]; then
  echo "No generated variants found. Running generate-variants.js..."
  node "$SCRIPT_DIR/generate-variants.js" "$TIER"
fi

echo "=== Compiling ${#CIRCUITS[@]} JoinSplit circuit variants ($TIER) ==="
echo "Build directory: $BUILD_DIR"

for circuit in "${CIRCUITS[@]}"; do
  echo ""
  echo "--- Compiling: $circuit ---"

  CIRCUIT_BUILD="$BUILD_DIR/$circuit"
  mkdir -p "$CIRCUIT_BUILD"

  CIRCUIT_FILE="$GENERATED_DIR/$circuit.circom"
  if [ ! -f "$CIRCUIT_FILE" ]; then
    echo "  SKIP: $CIRCUIT_FILE not found"
    continue
  fi

  circom "$CIRCUIT_FILE" \
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
echo "=== All ${#CIRCUITS[@]} circuits compiled successfully ==="
