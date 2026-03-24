#!/usr/bin/env bun
/**
 * Register a new supported token on-chain.
 *
 * Usage:
 *   bun run scripts/register-token.ts <mint_address> [options]
 *
 * Options:
 *   --service-fee <sats>    Service fee in smallest units (default: 2000)
 *   --min-deposit <amount>  Minimum deposit (default: 1000)
 *   --max-deposit <amount>  Maximum deposit (default: 10000000000)
 *   --deposit-cap <amount>  Total deposit cap (default: 100000000000)
 */

import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { setupScript } from "./lib/common.ts";

// Parse args
const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith("-")) {
  console.error("Usage: bun run scripts/register-token.ts <mint_address> [options]");
  process.exit(1);
}
const mintAddress = args[0];
const getArg = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const serviceFee = BigInt(getArg("--service-fee", "2000"));
const minDeposit = BigInt(getArg("--min-deposit", "1000"));
const maxDeposit = BigInt(getArg("--max-deposit", "10000000000"));
const depositCap = BigInt(getArg("--deposit-cap", "100000000000"));

// Setup
const { conn, authority, programId, poolState } = setupScript();
const mint = new PublicKey(mintAddress);

const [tokenConfigPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("token_config"), mint.toBuffer()], programId,
);

console.log(`\n=== Register Token ===`);
console.log(`Mint:         ${mint.toBase58()}`);
console.log(`Program:      ${programId.toBase58()}`);
console.log(`Authority:    ${authority.publicKey.toBase58()}`);
console.log(`TokenConfig:  ${tokenConfigPDA.toBase58()}`);

// Create vault ATA if needed
const vault = await getOrCreateAssociatedTokenAccount(
  conn, authority, mint, poolState,
  true, undefined, undefined, TOKEN_2022_PROGRAM_ID,
);
console.log(`Vault ATA:    ${vault.address.toBase58()}`);

// Build register instruction
const payload = Buffer.alloc(32);
payload.writeBigUInt64LE(serviceFee, 0);
payload.writeBigUInt64LE(minDeposit, 8);
payload.writeBigUInt64LE(maxDeposit, 16);
payload.writeBigUInt64LE(depositCap, 24);

const ix = new TransactionInstruction({
  keys: [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: poolState, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: tokenConfigPDA, isSigner: false, isWritable: true },
    { pubkey: vault.address, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  programId,
  data: Buffer.concat([Buffer.from([28]), payload]), // disc 28 = REGISTER_TOKEN
});

try {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [authority], { commitment: "confirmed" });
  console.log(`\nToken registered: ${sig}`);
} catch (e: any) {
  if (e.message?.includes("already in use")) {
    console.log("\nTokenConfig already exists for this mint.");
  } else {
    console.error("\nFailed:", e.message);
    if (e.logs) e.logs.forEach((l: string) => console.error(`  ${l}`));
  }
}
