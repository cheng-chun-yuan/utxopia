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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/build"
GENERATED_DIR="$ROOT_DIR/circom/generated"

TIER="${1:---tier1}"

# Define tier variants
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
