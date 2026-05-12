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

if [ "${1:-}" = "--rebuild" ]; then
  echo "Rebuilding circuits from source (requires circom + snarkjs)..."
  cd "$REPO_ROOT/circuits"
  bash scripts/compile.sh --tier2
  bash scripts/setup.sh --tier2
  echo "Done. Artifacts in $BUILD_DIR/"
  exit 0
fi

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
