#!/usr/bin/env bun
/**
 * Selective disclosure CLI — ownership proof
 *
 * Generates a zero-knowledge proof of "I own commitment X, and its amount is
 * at least Y" without spending the note or revealing other holdings.
 *
 * Usage:
 *   bun run scripts/auditor/prove-ownership.ts \
 *       --seed <hex> \
 *       --commitment <decimal> \
 *       --merkle-root <decimal> \
 *       --threshold <decimal> \
 *       --token-id <decimal-or-0xhex> \
 *       --random <decimal> \
 *       --value <decimal> \
 *       --path-elements <comma-separated-decimals> \
 *       --path-indices <comma-separated-0-or-1> \
 *       [--out proof.bin]
 *
 * Wallet integration: in practice the SDK helper (UTXOpiaClient) will populate
 * `random`, `value`, `pathElements`, `pathIndices` automatically from a
 * scanned note. This CLI is the manual escape hatch for debugging + audit
 * scripts that have raw witness data in hand.
 */

import * as fs from "node:fs";
import { generateOwnershipProof, deriveKeysFromSeed } from "../../sdk/dist/index.js";
import { setCircuitPath } from "../../sdk/dist/prover/web.js";

interface CliArgs {
  seedHex: string;
  commitment: bigint;
  merkleRoot: bigint;
  threshold: bigint;
  tokenId: bigint;
  random: bigint;
  value: bigint;
  pathElements: bigint[];
  pathIndices: number[];
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let seedHex = "";
  let commitment = 0n;
  let merkleRoot = 0n;
  let threshold = 0n;
  let tokenId = 0n;
  let random = 0n;
  let value = 0n;
  let pathElements: bigint[] = [];
  let pathIndices: number[] = [];
  let out: string | undefined;

  const num = (s: string): bigint => (s.startsWith("0x") ? BigInt(s) : BigInt(s));

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") seedHex = argv[++i];
    else if (a === "--commitment") commitment = num(argv[++i]);
    else if (a === "--merkle-root") merkleRoot = num(argv[++i]);
    else if (a === "--threshold") threshold = num(argv[++i]);
    else if (a === "--token-id") tokenId = num(argv[++i]);
    else if (a === "--random") random = num(argv[++i]);
    else if (a === "--value") value = num(argv[++i]);
    else if (a === "--path-elements")
      pathElements = argv[++i].split(",").map((s) => num(s.trim()));
    else if (a === "--path-indices")
      pathIndices = argv[++i].split(",").map((s) => Number(s.trim()));
    else if (a === "--out") out = argv[++i];
    else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }

  if (!seedHex || !pathElements.length || !pathIndices.length) {
    printUsage();
    throw new Error("--seed, --path-elements, and --path-indices are required");
  }

  return {
    seedHex,
    commitment,
    merkleRoot,
    threshold,
    tokenId,
    random,
    value,
    pathElements,
    pathIndices,
    out,
  };
}

function printUsage(): void {
  console.error(
    [
      "Usage: bun run scripts/auditor/prove-ownership.ts [flags]",
      "",
      "Required:",
      "  --seed <hex>          32-byte seed (64 hex chars)",
      "  --commitment <bigint> commitment to attest to",
      "  --merkle-root <bigint> tree root the commitment is in",
      "  --threshold <bigint>  minimum amount being asserted",
      "  --token-id <bigint>   token id",
      "  --random <bigint>     randomness used in NPK derivation",
      "  --value <bigint>      actual amount in the note",
      "  --path-elements x,y,...  16 Merkle siblings (decimals)",
      "  --path-indices 0,1,...   16 direction bits",
      "",
      "Optional:",
      "  --out <path>          write 256-byte proof to file (default stdout hex)",
      "  --circuit-path <path> override circuit base path (defaults to ./circuits/build)",
    ].join("\n"),
  );
}

function decodeHex(s: string): Uint8Array {
  if (s.length !== 64) throw new Error(`seed must be 64 hex chars; got ${s.length}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.substring(2 * i, 2 * i + 2), 16);
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Point the prover at the local circuits build dir.
  setCircuitPath(process.env.CIRCUIT_PATH ?? "./circuits/build");

  const seed = decodeHex(args.seedHex);
  const keys = deriveKeysFromSeed(seed);

  process.stderr.write(`[ownership] generating proof for commitment=${args.commitment}\n`);
  process.stderr.write(`[ownership] threshold=${args.threshold} value=${args.value}\n`);

  const proofData = await generateOwnershipProof({
    spendingPrivScalar: keys.spendingPrivKey,
    nullifyingKey: keys.nullifyingKey,
    randomIn: args.random,
    valueIn: args.value,
    pathElements: args.pathElements,
    pathIndices: args.pathIndices,
    commitment: args.commitment,
    merkleRoot: args.merkleRoot,
    threshold: args.threshold,
    tokenId: args.tokenId,
  });

  process.stderr.write(`[ownership] proof generated (${proofData.proof.length} bytes)\n`);
  process.stderr.write(
    `[ownership] public inputs: ${JSON.stringify(proofData.publicInputs)}\n`,
  );

  if (args.out) {
    fs.writeFileSync(args.out, proofData.proof);
    process.stderr.write(`[ownership] wrote ${args.out}\n`);
  } else {
    process.stdout.write(Buffer.from(proofData.proof).toString("hex") + "\n");
  }
}

main().catch((err) => {
  console.error(`[ownership] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
