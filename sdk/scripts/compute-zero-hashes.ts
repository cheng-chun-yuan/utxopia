/**
 * Compute ZERO_HASHES for incremental Merkle tree
 *
 * Outputs the pre-computed zero hashes for each level of the tree.
 * These values must match exactly between SDK and on-chain contract.
 *
 * ZERO[0] = 0 (empty leaf)
 * ZERO[i] = Poseidon2(ZERO[i-1], ZERO[i-1])
 */

import { poseidon2Hash } from "../src/poseidon2";

const TREE_DEPTH = 20;

function computeZeroHashes(): bigint[] {
  const zeroHashes: bigint[] = [];

  // Level 0: empty leaf is zero
  zeroHashes[0] = 0n;

  // Compute each level: H(zero[i-1], zero[i-1])
  for (let i = 1; i <= TREE_DEPTH; i++) {
    const prev = zeroHashes[i - 1];
    zeroHashes[i] = poseidon2Hash([prev, prev]);
  }

  return zeroHashes;
}

function bigintToHex(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

function bigintToRustBytes(n: bigint): string {
  const hex = bigintToHex(n);
  return `hex_literal::hex!("${hex}")`;
}

// Compute and output
const zeroHashes = computeZeroHashes();

console.log("// ZERO_HASHES for incremental Merkle tree (Poseidon2 on BN254)");
console.log("// ZERO[0] = 0 (empty leaf)");
console.log("// ZERO[i] = Poseidon2(ZERO[i-1], ZERO[i-1])\n");

console.log("=== Rust format (for contract) ===\n");
console.log("pub const ZERO_HASHES: [[u8; 32]; TREE_DEPTH + 1] = [");
for (let i = 0; i <= TREE_DEPTH; i++) {
  const rustBytes = i === 0 ? "[0u8; 32]" : bigintToRustBytes(zeroHashes[i]);
  const comment = i === 0 ? "// Level 0: Empty leaf" : `// Level ${i}`;
  console.log(`    ${rustBytes}, ${comment}`);
}
console.log("];");

console.log("\n=== TypeScript format (for SDK) ===\n");
console.log("export const ZERO_HASHES: bigint[] = [");
for (let i = 0; i <= TREE_DEPTH; i++) {
  const hex = bigintToHex(zeroHashes[i]);
  const comment = i === 0 ? "// Level 0: Empty leaf" : `// Level ${i}`;
  console.log(`  0x${hex}n, ${comment}`);
}
console.log("];");

console.log("\n=== Verification ===");
console.log(`Tree depth: ${TREE_DEPTH}`);
console.log(`Total levels: ${TREE_DEPTH + 1}`);
console.log(`Empty tree root (ZERO_HASHES[${TREE_DEPTH}]): 0x${bigintToHex(zeroHashes[TREE_DEPTH])}`);
