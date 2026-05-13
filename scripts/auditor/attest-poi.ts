#!/usr/bin/env bun
/**
 * PoI attestation CLI (Phase 3c)
 *
 * Pulls the inclusion proof for a commitment from the off-chain PoI service,
 * generates a Groth16 PoI proof, and prints both the proof bytes and the
 * `attest_poi` instruction data ready to submit on chain.
 *
 * Usage:
 *   bun run scripts/auditor/attest-poi.ts \
 *       --commitment <decimal-or-0xhex> \
 *       [--service-url http://api.utxopia.com] \
 *       [--out attestation.json]
 */

import * as fs from "node:fs";
import {
  fetchPoIInclusion,
  generatePoIProof,
  buildAttestPoIInstructionData,
} from "../../sdk/dist/index.js";
import { setCircuitPath } from "../../sdk/dist/prover/web.js";

interface CliArgs {
  commitment: bigint;
  serviceUrl: string;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let commitment = 0n;
  let serviceUrl = "http://localhost:8080";
  let out: string | undefined;
  const num = (s: string) => (s.startsWith("0x") ? BigInt(s) : BigInt(s));

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--commitment") commitment = num(argv[++i]);
    else if (a === "--service-url") serviceUrl = argv[++i];
    else if (a === "--out") out = argv[++i];
    else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  if (commitment === 0n) {
    printUsage();
    throw new Error("--commitment is required");
  }
  return { commitment, serviceUrl, out };
}

function printUsage(): void {
  console.error(
    [
      "Usage: bun run scripts/auditor/attest-poi.ts [flags]",
      "",
      "Required:",
      "  --commitment <bigint>  commitment whose innocence to attest",
      "",
      "Optional:",
      "  --service-url <url>    PoI service base URL (default http://localhost:8080)",
      "  --out <path>           write { proof, instructionData } JSON to file",
    ].join("\n"),
  );
}

function bigintToBytes32BE(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setCircuitPath(process.env.CIRCUIT_PATH ?? "./circuits/build");

  process.stderr.write(
    `[attest-poi] fetching inclusion proof from ${args.serviceUrl}\n`,
  );
  const inclusion = await fetchPoIInclusion(args.serviceUrl, args.commitment);
  if (!inclusion) {
    throw new Error(
      "commitment is not in the current association set — refusing to generate a PoI proof",
    );
  }
  process.stderr.write(
    `[attest-poi] inclusion proof OK (associationRoot=${inclusion.associationRoot.toString(16).slice(0, 16)}...)\n`,
  );

  process.stderr.write(`[attest-poi] generating Groth16 PoI proof…\n`);
  const proofData = await generatePoIProof({
    associationRoot: inclusion.associationRoot,
    commitment: args.commitment,
    pathElements: inclusion.pathElements,
    pathIndices: inclusion.pathIndices,
  });
  process.stderr.write(`[attest-poi] proof ${proofData.proof.length} bytes\n`);

  const instructionData = buildAttestPoIInstructionData({
    commitment: bigintToBytes32BE(args.commitment),
    proofBytes: proofData.proof,
  });
  process.stderr.write(
    `[attest-poi] instruction data ${instructionData.length} bytes (disc 22)\n`,
  );

  const output = {
    associationRoot: inclusion.associationRoot.toString(),
    commitment: args.commitment.toString(),
    proofHex: Buffer.from(proofData.proof).toString("hex"),
    instructionDataHex: Buffer.from(instructionData).toString("hex"),
  };

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(output, null, 2) + "\n");
    process.stderr.write(`[attest-poi] wrote ${args.out}\n`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

main().catch((err) => {
  console.error(`[attest-poi] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
