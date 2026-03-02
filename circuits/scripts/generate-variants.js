#!/usr/bin/env node
/**
 * Generate JoinSplit circuit variant files
 *
 * Generates circom files for each (N, M) pair where N + M <= 14.
 * This produces 91 possible variants.
 *
 * Usage: node scripts/generate-variants.js [--tier1 | --tier2 | --all]
 *
 * Tiers:
 *   --tier1 (default): 1x1, 1x2, 2x1, 2x2
 *   --tier2: tier1 + 1x3, 3x1, 2x3, 3x2, 1x4, 4x1
 *   --all: all 91 variants (N=1..13, M=1..13, N+M<=14)
 */

const fs = require("fs");
const path = require("path");

const TREE_DEPTH = 16;
const MAX_SUM = 14; // N + M <= 14 (constraint from Poseidon arity limit of 16)

const tier = process.argv[2] || "--tier1";

const TIER1_VARIANTS = [
  [1, 1], [1, 2], [2, 1], [2, 2],
];

const TIER2_VARIANTS = [
  ...TIER1_VARIANTS,
  [1, 3], [3, 1], [2, 3], [3, 2], [1, 4], [4, 1],
  [1, 5], [5, 1], [3, 3], [2, 4], [4, 2], [1, 6], [6, 1], [2, 5], [5, 2],
];

function getAllVariants() {
  const variants = [];
  for (let n = 1; n <= MAX_SUM - 1; n++) {
    for (let m = 1; m <= MAX_SUM - n; m++) {
      variants.push([n, m]);
    }
  }
  return variants;
}

let variants;
switch (tier) {
  case "--tier1":
    variants = TIER1_VARIANTS;
    break;
  case "--tier2":
    variants = TIER2_VARIANTS;
    break;
  case "--all":
    variants = getAllVariants();
    break;
  default:
    console.error(`Unknown tier: ${tier}. Use --tier1, --tier2, or --all`);
    process.exit(1);
}

const outDir = path.join(__dirname, "..", "circom", "generated");
fs.mkdirSync(outDir, { recursive: true });

console.log(`=== Generating ${variants.length} JoinSplit variants (${tier}) ===`);
console.log(`Output directory: ${outDir}`);

for (const [n, m] of variants) {
  const name = `joinsplit_${n}x${m}`;
  const filePath = path.join(outDir, `${name}.circom`);

  const content = `pragma circom 2.1.0;

include "../joinsplit.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut]} = JoinSplit(${n}, ${m}, ${TREE_DEPTH});
`;

  fs.writeFileSync(filePath, content);
  console.log(`  Generated: ${name}.circom (${n} inputs, ${m} outputs)`);
}

console.log(`\n=== Generated ${variants.length} variants ===`);
