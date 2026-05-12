#!/usr/bin/env bun
//
// One-shot Ika dWallet setup.
//
// Runs the DKG flow once against Ika devnet, transfers authority of the
// resulting dWallet to our UTXOpia program's CPI authority PDA, and
// writes the dWallet ID + x-only pubkey + CPI authority bump into the
// state JSON for the chosen network.
//
// Usage:
//   bun run setup-dwallet.ts [--network localnet|devnet]
//
// Environment:
//   UTXOPIA_PROGRAM_ID    The Solana account address of our program
//   IKA_GRPC_URL               (optional) Override the Ika gRPC endpoint
//   PAYER_KEYPAIR_PATH         Path to a funded Solana keypair JSON
//
// References:
//   - chains/solana/examples/_shared/ika-setup.ts in dwallet-labs/ika-pre-alpha:
//     setupDWallet() shows the exact gRPC + on-chain dance.
//   - docs/recon/2026-05-09-ika-sdk-brief.md for our integration surface.
//
// Status: skeleton + runbook. The actual gRPC SignedRequestData payload and
// the on-chain dWallet-creation tx are vendored from the upstream example
// at run-time (see Step 3 below). Until the upstream maintainers ship a
// stable gRPC schema, this script is a guide rather than a turnkey runner.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const NETWORK = process.argv.includes("--network")
  ? process.argv[process.argv.indexOf("--network") + 1]
  : "localnet";

const STATE_FILE =
  NETWORK === "localnet"
    ? path.resolve(__dirname, "../e2e/localnet-state.json")
    : path.resolve(__dirname, "../devnet-state.json");

const RPC_URL =
  NETWORK === "localnet"
    ? "http://localhost:8899"
    : "https://api.devnet.solana.com";

const IKA_PROGRAM_ID = new PublicKey(
  "87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY"
);

const CPI_AUTHORITY_SEED = Buffer.from("__ika_cpi_authority");

// ── 1. Validate prerequisites ──────────────────────────────────────────────

const programIdStr = process.env.UTXOPIA_PROGRAM_ID;
if (!programIdStr) {
  console.error("error: UTXOPIA_PROGRAM_ID required");
  process.exit(1);
}
const privacyCoinProgramId = new PublicKey(programIdStr);

const payerPath = process.env.PAYER_KEYPAIR_PATH;
if (!payerPath || !existsSync(payerPath)) {
  console.error(
    "error: PAYER_KEYPAIR_PATH required (path to a funded Solana keypair JSON)"
  );
  process.exit(1);
}
const payerSecret = JSON.parse(readFileSync(payerPath, "utf-8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(payerSecret));

if (!existsSync(STATE_FILE)) {
  console.error(`error: state file not found at ${STATE_FILE}`);
  process.exit(1);
}

const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
const connection = new Connection(RPC_URL, "confirmed");

console.log("\n═══ Ika dWallet Setup ═══");
console.log(`Network:           ${NETWORK}`);
console.log(`Solana RPC:        ${RPC_URL}`);
console.log(`Ika program:       ${IKA_PROGRAM_ID.toBase58()}`);
console.log(`UTXOpia pid:  ${privacyCoinProgramId.toBase58()}`);
console.log(`Payer:             ${payer.publicKey.toBase58()}`);
console.log(`State file:        ${STATE_FILE}`);
console.log();

// ── 2. Derive our CPI authority PDA ────────────────────────────────────────

const [cpiAuthorityPda, cpiAuthorityBump] = PublicKey.findProgramAddressSync(
  [CPI_AUTHORITY_SEED],
  privacyCoinProgramId
);
console.log(
  `CPI authority PDA: ${cpiAuthorityPda.toBase58()} (bump ${cpiAuthorityBump})`
);

// ── 3. Run DKG via Ika gRPC ────────────────────────────────────────────────
//
// The actual gRPC dance lives in dwallet-labs/ika-pre-alpha at
//   chains/solana/examples/_shared/ika-setup.ts:setupDWallet
//
// To productionize this script, vendor that helper (or import it via
// `git submodule add ... vendor/ika-pre-alpha`) and call:
//
//   import { setupDWallet } from "../../vendor/ika-pre-alpha/.../ika-setup";
//   const dwallet = await setupDWallet(
//     connection, payer, IKA_PROGRAM_ID, privacyCoinProgramId,
//     process.env.IKA_GRPC_URL ?? "pre-alpha-dev-1.ika.ika-network.net:443",
//   );
//
// `dwallet` returns: { dwalletPda, publicKey, ... }. The compressed pubkey
// has a 0x02/0x03 prefix; strip it for the x-only.
//
// For the hackathon we run the upstream example's e2e directly to obtain
// values and paste them in via the runbook below.

console.log("\n── DKG flow ──");
console.log(
  "Run the upstream voting example end-to-end to materialize a dWallet:"
);
console.log("");
console.log(
  "  cd /tmp/ika-pre-alpha-scratch/ika-pre-alpha"
);
console.log("  cd chains/solana/examples/voting/e2e && bun install");
console.log(
  "  bun main.ts <DWALLET_PROGRAM_ID> <VOTING_PROGRAM_ID> 2>&1 | tee /tmp/ika-dkg.log"
);
console.log("");
console.log(
  "Then capture the dWallet PDA + compressed pubkey it prints, and re-run"
);
console.log(
  "this script with IKA_DWALLET_ID and IKA_DWALLET_PUBKEY_HEX env vars set."
);
console.log("");

const ikaDwalletId = process.env.IKA_DWALLET_ID;
const ikaDwalletPubkeyHex = process.env.IKA_DWALLET_PUBKEY_HEX;
if (!ikaDwalletId || !ikaDwalletPubkeyHex) {
  console.log("(no IKA_DWALLET_ID / IKA_DWALLET_PUBKEY_HEX set — exiting after derivation)");
  process.exit(0);
}

const dwalletPda = new PublicKey(ikaDwalletId);
const dwalletPubkeyBytes = Buffer.from(ikaDwalletPubkeyHex, "hex");
if (dwalletPubkeyBytes.length !== 33) {
  console.error("IKA_DWALLET_PUBKEY_HEX must be 33 bytes (compressed secp256k1)");
  process.exit(1);
}
const xOnlyPubkey = dwalletPubkeyBytes.subarray(1).toString("hex");

console.log(`dWallet PDA:       ${dwalletPda.toBase58()}`);
console.log(`x-only pubkey:     ${xOnlyPubkey}`);

// ── 4. Transfer dWallet authority to our CPI PDA ───────────────────────────

console.log("\n── Authority transfer ──");
console.log(
  "Send a `transfer_dwallet` ix (discriminator 24) to the Ika program with:"
);
console.log("  data: [24, ...new_authority(32)]");
console.log("  accounts:");
console.log(`    [0] caller_program = ${privacyCoinProgramId.toBase58()} (read, executable)`);
console.log(`    [1] cpi_authority  = ${cpiAuthorityPda.toBase58()} (read, signer via PDA)`);
console.log(`    [2] dwallet        = ${dwalletPda.toBase58()} (writable)`);
console.log(`  new_authority = ${cpiAuthorityPda.toBase58()}`);
console.log("");
console.log(
  "(This step requires our UTXOpia program to expose a `transfer_ika_dwallet_authority` ix or to do the transfer at pool init. For the hackathon we recommend doing it once via a one-shot test program or by extending set_pool_config.)"
);

// ── 5. Write back to state JSON ────────────────────────────────────────────

state.ika = {
  programId: IKA_PROGRAM_ID.toBase58(),
  grpcEndpoint: process.env.IKA_GRPC_URL ?? "pre-alpha-dev-1.ika.ika-network.net:443",
  dwallet: dwalletPda.toBase58(),
  dwalletXOnlyPubkey: xOnlyPubkey,
  cpiAuthorityBump,
};

writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
console.log(`\n✓ Wrote ika.* block to ${STATE_FILE}`);
console.log("\nNext step: run ./scripts/sync-env.sh to propagate to backend/.env and networks.json");
