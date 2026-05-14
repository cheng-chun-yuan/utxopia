#!/bin/bash
# scripts/fetch-circuits.sh
#
# Downloads JoinSplit circuit artifacts (wasm + zkey) into circuits/build/.
# The repo only commits *.vkey.json — the on-chain program is happy with vkey
# hashes alone. wasm + zkey are needed to GENERATE proofs (client-side) and are
# distributed out-of-band because they exceed GitHub's 100 MB hard limit.
#
# Source options (set CIRCUIT_RELEASE_URL):
#   - GitHub Release tarball:  https://github.com/<owner>/<repo>/releases/download/<tag>/circuits-tier2.tar.gz
#   - S3 / R2 bucket URL:      https://<bucket>.<region>.r2.cloudflarestorage.com/circuits-tier2.tar.gz
#   - IPFS / Filecoin:         https://gateway.ipfs.io/ipfs/<CID>/circuits-tier2.tar.gz
#
# Or override with --rebuild to regenerate from source instead of downloading
# (requires circom + snarkjs and ~30min):
#   bash scripts/fetch-circuits.sh --rebuild

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/circuits/build"
TARBALL="$BUILD_DIR/circuits-tier2.tar.gz"

# Replace with your real release URL when published.
DEFAULT_RELEASE_URL="https://github.com/cheng-chun-yuan/utxopia/releases/latest/download/circuits-tier2.tar.gz"
RELEASE_URL="${CIRCUIT_RELEASE_URL:-$DEFAULT_RELEASE_URL}"

# Auxiliary circuits (PoI, selective disclosure) — pulled file-by-file from
# the R2 public URL rather than the joinsplit tarball, since they're a
# different family with smaller blast radius. Override the base URL via
# CIRCUIT_R2_BASE; override the list via AUX_CIRCUITS.
AUX_R2_BASE="${CIRCUIT_R2_BASE:-https://circuits.utxopia.com}"
AUX_CIRCUITS="${AUX_CIRCUITS:-proof_of_innocence ownership range_sum range_sum_4}"

# Download wasm + zkey + vkey for a single aux circuit, mirroring the R2
# layout the SDK expects. Skips files that already exist locally.
fetch_aux_circuit() {
  local name="$1"
  local target_dir="$BUILD_DIR/$name"
  mkdir -p "$target_dir/${name}_js"
  for path in "${name}.zkey" "${name}.vkey.json" "${name}_js/${name}.wasm"; do
    local out="$target_dir/$path"
    if [ -f "$out" ]; then
      echo "  ✓ $name/$path (cached)"
      continue
    fi
    echo "  ↓ $name/$path"
    if ! curl -fL --retry 3 -o "$out" "$AUX_R2_BASE/$name/$path"; then
      echo "  ✗ failed to fetch $name/$path"
      return 1
    fi
  done
}

case "${1:-}" in
  --rebuild)
    echo "Rebuilding JoinSplit circuits from source (requires circom + snarkjs)..."
    cd "$REPO_ROOT/circuits"
    bash scripts/compile.sh --tier2
    bash scripts/setup.sh --tier2
    echo "Done. JoinSplit artifacts in $BUILD_DIR/"
    exit 0
    ;;
  --aux)
    echo "Fetching aux circuits from $AUX_R2_BASE..."
    failures=0
    for circuit in $AUX_CIRCUITS; do
      fetch_aux_circuit "$circuit" || failures=$((failures + 1))
    done
    if [ "$failures" -ne 0 ]; then
      echo ""
      echo "ERROR: $failures aux circuit(s) failed to download."
      echo "Either set CIRCUIT_R2_BASE to a valid public URL, or rebuild locally:"
      echo "  bash circuits/scripts/build-aux.sh <name>"
      exit 1
    fi
    echo "✓ Aux circuits present in $BUILD_DIR"
    exit 0
    ;;
esac

mkdir -p "$BUILD_DIR"
echo "Fetching circuit artifacts from:"
echo "  $RELEASE_URL"

if ! curl -fL --retry 3 -o "$TARBALL" "$RELEASE_URL"; then
  echo "ERROR: download failed. Either:"
  echo "  1) Publish the artifacts to a release and update CIRCUIT_RELEASE_URL, or"
  echo "  2) Run 'bash scripts/fetch-circuits.sh --rebuild' to generate locally."
  exit 1
fi

echo "Extracting into $BUILD_DIR/..."
tar -xzf "$TARBALL" -C "$BUILD_DIR"
rm "$TARBALL"

# Sanity check: each committed vkey should now have a sibling wasm + zkey.
missing=0
for vkey in "$BUILD_DIR"/joinsplit_*/*.vkey.json; do
  [ -f "$vkey" ] || continue
  dir="$(dirname "$vkey")"
  name="$(basename "$dir")"
  [ -f "$dir/${name}.zkey" ] || { echo "  MISSING: $dir/${name}.zkey"; missing=1; }
  [ -f "$dir/${name}_js/${name}.wasm" ] || { echo "  MISSING: $dir/${name}_js/${name}.wasm"; missing=1; }
done
if [ "$missing" -ne 0 ]; then
  echo "Some artifacts are missing — tarball may be incomplete."
  exit 1
fi

echo "✓ All circuit artifacts present in $BUILD_DIR"
