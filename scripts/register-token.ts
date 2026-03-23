#!/usr/bin/env bun
/**
 * Register a new supported token on-chain.
 *
 * This creates a TokenConfig PDA for the given SPL mint, enabling it
 * for shielded deposits/transfers in the privacy pool.
 *
 * Usage:
 *   bun run scripts/register-token.ts <mint_address> [options]
 *
 * Options:
 *   --service-fee <sats>    Service fee in smallest units (default: 2000)
 *   --min-deposit <amount>  Minimum deposit (default: 1000)
 *   --max-deposit <amount>  Maximum deposit (default: 10000000000)
 *   --deposit-cap <amount>  Total deposit cap (default: 100000000000)
 *   --network <devnet|localnet>  Network (default: from env)
 *
 * Example:
 *   bun run scripts/register-token.ts 6eD9uhGpUtZ8dciNR5RF4yvH5sLDpHnWmCRhDh2CTCVV \
 *     --service-fee 2000 --min-deposit 1000
 *
 * Prerequisites:
 *   1. Pool must be initialized (run e2e/run-all.ts or deploy-devnet.sh first)
 *   2. RELAYER_KEYPAIR must be the pool authority
 *   3. A vault ATA must exist for this mint under the pool state PDA
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { readFileSync, existsSync } from "fs";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith("-")) {
  console.error("Usage: bun run scripts/register-token.ts <mint_address> [options]");
  console.error("  --service-fee <amount>   (default: 2000)");
  console.error("  --min-deposit <amount>   (default: 1000)");
  console.error("  --max-deposit <amount>   (default: 10000000000)");
  console.error("  --deposit-cap <amount>   (default: 100000000000)");
  process.exit(1);
}

const mintAddress = args[0];
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const serviceFee = BigInt(getArg("--service-fee", "2000"));
const minDeposit = BigInt(getArg("--min-deposit", "1000"));
const maxDeposit = BigInt(getArg("--max-deposit", "10000000000"));
const depositCap = BigInt(getArg("--deposit-cap", "100000000000"));

// ---------------------------------------------------------------------------
// Load state
// ---------------------------------------------------------------------------

// Try devnet-state.json first, then localnet-state.json
let state: Record<string, string>;
if (existsSync("scripts/devnet-state.json")) {
  state = JSON.parse(readFileSync("scripts/devnet-state.json", "utf8"));
} else if (existsSync("scripts/e2e/localnet-state.json")) {
  state = JSON.parse(readFileSync("scripts/e2e/localnet-state.json", "utf8"));
} else {
  console.error("No state file found. Run deploy or e2e first.");
  process.exit(1);
}

const PROGRAM_ID = new PublicKey(state.aegisProgramId);
const POOL_STATE = new PublicKey(state.poolState);

// Load authority keypair
let authority: Keypair;
const envPath = existsSync("backend/.env.devnet") ? "backend/.env.devnet" : "backend/.env.localnet";
const envContent = readFileSync(envPath, "utf8");
const match = envContent.match(/RELAYER_KEYPAIR=(\[[\d,\s]+\])/);
if (match) {
  authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(match[1])));
} else {
  console.error("RELAYER_KEYPAIR not found in", envPath);
  process.exit(1);
}

const rpcUrl = process.env.SOLANA_RPC_URL || (state.signingMode === "frost" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899");
const connection = new Connection(rpcUrl, "confirmed");

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

const REGISTER_TOKEN_DISC = 28;
const mint = new PublicKey(mintAddress);

// Derive TokenConfig PDA
const [tokenConfigPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("token_config"), mint.toBuffer()],
  PROGRAM_ID,
);

// Create or get vault ATA (pool_state is the owner)
console.log(`\n=== Register Token ===`);
console.log(`Mint:         ${mint.toBase58()}`);
console.log(`Program:      ${PROGRAM_ID.toBase58()}`);
console.log(`Authority:    ${authority.publicKey.toBase58()}`);
console.log(`TokenConfig:  ${tokenConfigPDA.toBase58()}`);
console.log(`Service Fee:  ${serviceFee}`);
console.log(`Min Deposit:  ${minDeposit}`);
console.log(`Max Deposit:  ${maxDeposit}`);
console.log(`Deposit Cap:  ${depositCap}`);
console.log();

// Create vault ATA if needed
const vault = await getOrCreateAssociatedTokenAccount(
  connection,
  authority,
  mint,
  POOL_STATE,
  true,  // allowOwnerOffCurve (PDA owner)
  undefined,
  undefined,
  TOKEN_2022_PROGRAM_ID,
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
    { pubkey: POOL_STATE, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: tokenConfigPDA, isSigner: false, isWritable: true },
    { pubkey: vault.address, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  programId: PROGRAM_ID,
  data: Buffer.concat([Buffer.from([REGISTER_TOKEN_DISC]), payload]),
});

const tx = new Transaction().add(ix);
try {
  const sig = await sendAndConfirmTransaction(connection, tx, [authority], {
    commitment: "confirmed",
  });
  console.log(`\nToken registered: ${sig}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Add token to aegis-app/src/lib/supported-tokens.ts`);
  console.log(`  2. Set NEXT_PUBLIC_<SYMBOL>_MINT env var on Vercel`);
  console.log(`  3. Add token logo to aegis-app/public/tokens/`);
} catch (e: any) {
  if (e.message?.includes("already in use")) {
    console.log("\nTokenConfig already exists for this mint.");
  } else {
    console.error("\nFailed:", e.message);
    if (e.logs) e.logs.forEach((l: string) => console.error(`  ${l}`));
  }
}
