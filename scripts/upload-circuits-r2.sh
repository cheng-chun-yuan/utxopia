#!/bin/bash
# Upload JoinSplit circuit .zkey files to Cloudflare R2
# Prerequisites: npm install -g wrangler && wrangler login
#
# Usage: bash scripts/upload-circuits-r2.sh [--tier1] [--tier2] [--all]
#   --tier1  Upload tier 1 circuits only (1x1, 1x2, 2x1, 2x2)
#   --tier2  Upload tier 1+2 circuits (N+M <= 4, 10 variants)
#   --all    Upload all 91 circuit variants (default)

set -euo pipefail

BUCKET="zvault-circuits"
CIRCUIT_DIR="aegis-app/public/circuits/groth16"

TIER1=(joinsplit_1x1 joinsplit_1x2 joinsplit_2x1 joinsplit_2x2)
TIER2=(joinsplit_1x1 joinsplit_1x2 joinsplit_1x3 joinsplit_1x4 joinsplit_2x1 joinsplit_2x2 joinsplit_2x3 joinsplit_3x1 joinsplit_3x2 joinsplit_4x1)

MODE="${1:---all}"

upload_circuit() {
  local name="$1"
  local zkey="$CIRCUIT_DIR/$name/${name}.zkey"
  if [ ! -f "$zkey" ]; then
    echo "SKIP: $zkey not found"
    return
  fi
  local size=$(du -h "$zkey" | cut -f1)
  echo "Uploading $name ($size)..."
  npx wrangler r2 object put "$BUCKET/circuits/groth16/${name}/${name}.zkey" \
    --file "$zkey" \
    --content-type "application/octet-stream" \
    --remote
}

case "$MODE" in
  --tier1)
    echo "Uploading tier 1 circuits (${#TIER1[@]} variants)..."
    for c in "${TIER1[@]}"; do upload_circuit "$c"; done
    ;;
  --tier2)
    echo "Uploading tier 1+2 circuits (${#TIER2[@]} variants)..."
    for c in "${TIER2[@]}"; do upload_circuit "$c"; done
    ;;
  --all)
    echo "Uploading all circuits..."
    for dir in $CIRCUIT_DIR/joinsplit_*/; do
      name=$(basename "$dir")
      upload_circuit "$name"
    done
    ;;
  *)
    echo "Usage: $0 [--tier1|--tier2|--all]"
    exit 1
    ;;
esac

echo "Done! Configure custom domain: circuits.aegis.xyz -> R2 bucket"
