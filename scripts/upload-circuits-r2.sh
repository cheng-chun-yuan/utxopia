#!/bin/bash
# Upload circuit artifacts to Cloudflare R2.
#
# Prerequisites: npm install -g wrangler && wrangler login
#
# Modes:
#   --tier1          tier 1 JoinSplits (1x1, 1x2, 2x1, 2x2) — zkey only
#   --tier2          tier 1+2 JoinSplits (N+M <= 4)        — zkey only
#   --all            all JoinSplit variants in $JS_DIR     — zkey only
#   --aux            auxiliary circuits (PoI, ownership,
#                    range_sum, range_sum_4)               — wasm + zkey + vkey
#   --aux <name>     a single auxiliary circuit by name    — wasm + zkey + vkey
#   --everything     --all + --aux
#
# Source paths (override via env):
#   JS_DIR  default web/public/circuits/groth16
#   AUX_DIR default circuits/build
#
# After upload, set NEXT_PUBLIC_CIRCUIT_CDN_URL on the web app to the R2
# public URL (e.g. https://circuits.utxopia.com) so the SDK fetches
# `<url>/<name>/<name>.{zkey,_js/{name}.wasm,vkey.json}`.

set -euo pipefail

BUCKET="${CIRCUIT_BUCKET:-zvault-circuits}"
R2_PREFIX="${CIRCUIT_R2_PREFIX:-circuits/groth16}"
JS_DIR="${JS_DIR:-web/public/circuits/groth16}"
AUX_DIR="${AUX_DIR:-circuits/build}"

TIER1=(joinsplit_1x1 joinsplit_1x2 joinsplit_2x1 joinsplit_2x2)
TIER2=(joinsplit_1x1 joinsplit_1x2 joinsplit_1x3 joinsplit_1x4 joinsplit_2x1 joinsplit_2x2 joinsplit_2x3 joinsplit_3x1 joinsplit_3x2 joinsplit_4x1)
AUX_DEFAULT=(proof_of_innocence ownership range_sum range_sum_4)

# Upload a single file to R2; warns + skips if missing.
upload_file() {
  local src="$1"
  local key="$2"
  if [ ! -f "$src" ]; then
    echo "  SKIP (missing): $src"
    return
  fi
  local size
  size=$(du -h "$src" | cut -f1)
  echo "  → $key ($size)"
  npx wrangler r2 object put "$BUCKET/$key" \
    --file "$src" \
    --content-type "application/octet-stream" \
    --remote
}

# JoinSplit variant: zkey only (wasm + vkey are committed in web/public).
upload_joinsplit() {
  local name="$1"
  echo "[joinsplit] $name"
  upload_file "$JS_DIR/$name/${name}.zkey" "$R2_PREFIX/$name/${name}.zkey"
}

# Auxiliary circuit: wasm + zkey + vkey. Sourced from circuits/build/
# because aux artifacts aren't always committed to web/public (the 20M
# range_sum_4 zkey in particular).
upload_aux() {
  local name="$1"
  echo "[aux] $name"
  upload_file "$AUX_DIR/$name/${name}.zkey" "$R2_PREFIX/$name/${name}.zkey"
  upload_file "$AUX_DIR/$name/${name}_js/${name}.wasm" "$R2_PREFIX/$name/${name}_js/${name}.wasm"
  upload_file "$AUX_DIR/$name/${name}.vkey.json" "$R2_PREFIX/$name/${name}.vkey.json"
}

usage() {
  # Print the leading comment block (header docs) and exit. Stops at the
  # first non-comment / blank line so it works on both GNU and BSD tools.
  awk 'NR>1 && /^[^#]/{exit} NR>1{sub(/^# ?/,""); print}' "$0"
  exit 1
}

MODE="${1:-}"
if [ -z "$MODE" ]; then usage; fi

case "$MODE" in
  --tier1)
    echo "Uploading tier 1 JoinSplits (${#TIER1[@]})..."
    for c in "${TIER1[@]}"; do upload_joinsplit "$c"; done
    ;;
  --tier2)
    echo "Uploading tier 1+2 JoinSplits (${#TIER2[@]})..."
    for c in "${TIER2[@]}"; do upload_joinsplit "$c"; done
    ;;
  --all)
    echo "Uploading all JoinSplit variants from $JS_DIR..."
    for dir in "$JS_DIR"/joinsplit_*/; do
      [ -d "$dir" ] || continue
      upload_joinsplit "$(basename "$dir")"
    done
    ;;
  --aux)
    NAME="${2:-}"
    if [ -n "$NAME" ]; then
      upload_aux "$NAME"
    else
      echo "Uploading auxiliary circuits (${#AUX_DEFAULT[@]})..."
      for c in "${AUX_DEFAULT[@]}"; do upload_aux "$c"; done
    fi
    ;;
  --everything)
    echo "Uploading all JoinSplits + all aux..."
    for dir in "$JS_DIR"/joinsplit_*/; do
      [ -d "$dir" ] || continue
      upload_joinsplit "$(basename "$dir")"
    done
    for c in "${AUX_DEFAULT[@]}"; do upload_aux "$c"; done
    ;;
  *)
    usage
    ;;
esac

echo ""
echo "Done."
echo "Next: set NEXT_PUBLIC_CIRCUIT_CDN_URL=https://<your-r2-public-domain> on the web app."
