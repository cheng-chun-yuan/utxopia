#!/usr/bin/env bun
/**
 * One-shot Solana-native Ika DKG runner for Privacy Coin.
 *
 * Replaces the runbook-driven setup-dwallet.ts. Flow:
 *   1. gRPC DKG against Ika devnet for curve=Secp256k1.
 *   2. Poll for the on-chain dWallet PDA on Solana devnet.
 *   3. Submit the transfer-ownership ix (disc 24) so the dWallet's
 *      authority becomes our program's CPI authority PDA.
 *   4. Write {dwallet, dwalletXOnlyPubkey, cpiAuthorityBump} into the
 *      network state JSON.
 *
 * Burns ~5000 lamports of SOL on the payer for the on-chain transfer ix.
 * No Sui involvement.
 *
 * Usage:
 *   PRIVACY_COIN_PROGRAM_ID=<pid> PAYER_KEYPAIR_PATH=<path> \
 *     bun run dkg.ts --network devnet
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { setupDWallet } from "./lib/ika-setup-vendored.ts";

const NETWORK = process.argv.includes("--network")
  ? process.argv[process.argv.indexOf("--network") + 1]
  : "devnet";

const STATE_FILE =
  NETWORK === "localnet"
    ? path.resolve(import.meta.dirname ?? ".", "../e2e/localnet-state.json")
    : path.resolve(import.meta.dirname ?? ".", "../devnet-state.json");

const RPC_URL =
  NETWORK === "localnet"
    ? "http://localhost:8899"
    : "https://api.devnet.solana.com";

const IKA_PROGRAM_ID = new PublicKey(
  "87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY",
);

const programIdStr = process.env.PRIVACY_COIN_PROGRAM_ID;
if (!programIdStr) {
  console.error("error: PRIVACY_COIN_PROGRAM_ID required");
  process.exit(1);
}
const privacyCoinProgramId = new PublicKey(programIdStr);

const payerPath = process.env.PAYER_KEYPAIR_PATH;
if (!payerPath || !existsSync(payerPath)) {
  console.error(
    "error: PAYER_KEYPAIR_PATH required (path to a funded Solana keypair JSON)",
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

console.log("\n═══ Ika dWallet DKG (Secp256k1 + Taproot) ═══");
console.log(`Network:           ${NETWORK}`);
console.log(`Solana RPC:        ${RPC_URL}`);
console.log(`Ika program:       ${IKA_PROGRAM_ID.toBase58()}`);
console.log(`Privacy Coin pid:  ${privacyCoinProgramId.toBase58()}`);
console.log(`Payer:             ${payer.publicKey.toBase58()}`);
console.log(`State file:        ${STATE_FILE}`);
console.log();

// Pre-flight: log the payer's balance.
const lamports = await connection.getBalance(payer.publicKey);
console.log(`Payer balance:     ${(lamports / 1e9).toFixed(6)} SOL`);
if (lamports < 100_000) {
  console.error(
    "warning: payer balance is below 0.0001 SOL — transfer-ownership ix may fail",
  );
}

// Run the full setup against Ika devnet.
const result = await setupDWallet(
  connection,
  payer,
  IKA_PROGRAM_ID,
  privacyCoinProgramId,
  process.env.IKA_GRPC_URL ?? "pre-alpha-dev-1.ika.ika-network.net:443",
  "Secp256k1",
);

console.log("\n── DKG result ──");
console.log(`dWallet PDA:       ${result.dwalletPda.toBase58()}`);
console.log(`CPI authority:     ${result.cpiAuthority.toBase58()}`);
console.log(`Bump:              ${result.cpiAuthorityBump}`);
console.log(
  `Public key (hex):  ${Buffer.from(result.publicKey).toString("hex")}`,
);
console.log(`Public key length: ${result.publicKey.length} bytes`);

// Compressed Secp256k1 pubkey is 33 bytes (0x02|0x03 prefix + 32 bytes x).
// x-only is the 32-byte x-coordinate (bytes 1..33).
let xOnlyHex: string;
if (result.publicKey.length === 33) {
  xOnlyHex = Buffer.from(result.publicKey.subarray(1)).toString("hex");
} else if (result.publicKey.length === 32) {
  xOnlyHex = Buffer.from(result.publicKey).toString("hex");
} else {
  throw new Error(
    `Unexpected pubkey length ${result.publicKey.length}; expected 32 or 33`,
  );
}
console.log(`x-only (hex):      ${xOnlyHex}`);

// Write state JSON.
state.ika = {
  programId: IKA_PROGRAM_ID.toBase58(),
  grpcEndpoint:
    process.env.IKA_GRPC_URL ?? "pre-alpha-dev-1.ika.ika-network.net:443",
  dwallet: result.dwalletPda.toBase58(),
  dwalletXOnlyPubkey: xOnlyHex,
  cpiAuthorityBump: result.cpiAuthorityBump,
};

writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
console.log(`\n✓ Wrote ika.* block to ${STATE_FILE}`);
console.log(
  "\nNext step: PRIVACY_COIN_NETWORK=" +
    NETWORK +
    " ./scripts/sync-env.sh",
);
