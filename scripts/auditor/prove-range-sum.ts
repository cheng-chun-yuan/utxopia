#!/usr/bin/env bun
/**
 * Selective disclosure CLI — range-sum proof
 *
 * Generates a zero-knowledge proof of "the sum of values across these N notes
 * is ≤ ceiling" without revealing the individual values. The compiled variant
 * is picked automatically from `notes.length` — see `RANGE_SUM_SIZES` for
 * the list of supported cardinalities (today: 4 and 8). Pad with zero-value
 * notes if your actual cardinality doesn't match a compiled variant.
 *
 * Usage (witness data passed via JSON for brevity):
 *   bun run scripts/auditor/prove-range-sum.ts \
 *       --seed <hex> \
 *       --notes <path/to/notes.json> \
 *       --merkle-root <decimal> \
 *       --ceiling <decimal> \
 *       --token-id <decimal-or-0xhex> \
 *       --viewer-nonce <decimal> \
 *       [--out proof.bin]
 *
 * notes.json shape (array of N):
 *   [{ "randomIn":"...", "valueIn":"...", "commitment":"...", "leafIndex": N,
 *      "pathElements": ["..." x 16], "pathIndices": [0|1 x 16] }, ...]
 */

import * as fs from "node:fs";
import {
  generateRangeSumProof,
  deriveKeysFromSeed,
  computeRangeSumAttestation,
  RANGE_SUM_SIZES,
} from "../../sdk/dist/index.js";
import { setCircuitPath } from "../../sdk/dist/prover/web.js";

interface CliArgs {
  seedHex: string;
  notesPath: string;
  merkleRoot: bigint;
  ceiling: bigint;
  tokenId: bigint;
  viewerNonce: bigint;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let seedHex = "";
  let notesPath = "";
  let merkleRoot = 0n;
  let ceiling = 0n;
  let tokenId = 0n;
  let viewerNonce = 0n;
  let out: string | undefined;

  const num = (s: string): bigint => (s.startsWith("0x") ? BigInt(s) : BigInt(s));

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") seedHex = argv[++i];
    else if (a === "--notes") notesPath = argv[++i];
    else if (a === "--merkle-root") merkleRoot = num(argv[++i]);
    else if (a === "--ceiling") ceiling = num(argv[++i]);
    else if (a === "--token-id") tokenId = num(argv[++i]);
    else if (a === "--viewer-nonce") viewerNonce = num(argv[++i]);
    else if (a === "--out") out = argv[++i];
    else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }

  if (!seedHex || !notesPath) {
    printUsage();
    throw new Error("--seed and --notes are required");
  }
  return { seedHex, notesPath, merkleRoot, ceiling, tokenId, viewerNonce, out };
}

function printUsage(): void {
  console.error(
    [
      "Usage: bun run scripts/auditor/prove-range-sum.ts [flags]",
      "",
      "Required:",
      "  --seed <hex>           32-byte seed (64 hex chars)",
      "  --notes <path>         JSON array of 8 note objects (see header)",
      "  --merkle-root <bigint> root the notes were spent against",
      "  --ceiling <bigint>     upper bound on the disclosed sum",
      "  --token-id <bigint>    token id",
      "  --viewer-nonce <bigint> salt the verifier provided",
      "",
      "Optional:",
      "  --out <path>           write 256-byte proof to file (default stdout hex)",
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
  setCircuitPath(process.env.CIRCUIT_PATH ?? "./circuits/build");

  const seed = decodeHex(args.seedHex);
  const keys = deriveKeysFromSeed(seed);

  const notesRaw = JSON.parse(fs.readFileSync(args.notesPath, "utf-8")) as Array<{
    randomIn: string;
    valueIn: string;
    commitment: string;
    leafIndex: number;
    pathElements: string[];
    pathIndices: number[];
  }>;
  if (!RANGE_SUM_SIZES.includes(notesRaw.length)) {
    throw new Error(
      `notes count ${notesRaw.length} has no compiled range_sum variant. ` +
        `Supported sizes: ${RANGE_SUM_SIZES.join(", ")}. ` +
        `Pad with zero-value notes or compile a new variant (see circuits/scripts/build-aux.sh).`,
    );
  }
  const notes = notesRaw.map((n) => ({
    randomIn: BigInt(n.randomIn),
    valueIn: BigInt(n.valueIn),
    commitment: BigInt(n.commitment),
    leafIndex: n.leafIndex,
    pathElements: n.pathElements.map((e) => BigInt(e)),
    pathIndices: n.pathIndices,
  }));

  // Compute the attestation public input. Style (flat vs chunked) is picked
  // from the variant registry — N=16 chunks because circomlib's Poseidon
  // caps at arity 16. The verifier independently recomputes this from
  // (leafIndices, viewerNonce) and rejects on mismatch.
  const attestation = await computeRangeSumAttestation(
    notes.map((n) => n.leafIndex),
    args.viewerNonce,
  );

  process.stderr.write(`[range-sum] attestation: ${attestation.toString()}\n`);
  process.stderr.write(`[range-sum] generating proof…\n`);

  const proofData = await generateRangeSumProof({
    notes,
    spendingPrivScalar: keys.spendingPrivKey,
    nullifyingKey: keys.nullifyingKey,
    merkleRoot: args.merkleRoot,
    ceiling: args.ceiling,
    tokenId: args.tokenId,
    viewerNonce: args.viewerNonce,
    attestation,
  });

  process.stderr.write(`[range-sum] proof bytes: ${proofData.proof.length}\n`);
  process.stderr.write(
    `[range-sum] public inputs: ${JSON.stringify(proofData.publicInputs)}\n`,
  );

  if (args.out) {
    fs.writeFileSync(args.out, proofData.proof);
    process.stderr.write(`[range-sum] wrote ${args.out}\n`);
  } else {
    process.stdout.write(Buffer.from(proofData.proof).toString("hex") + "\n");
  }
}

main().catch((err) => {
  console.error(`[range-sum] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
