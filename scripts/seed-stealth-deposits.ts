#!/usr/bin/env bun
/**
 * Seed demo deposits to a specific stealth address on devnet.
 *
 * Uses ADD_DEMO_STEALTH (disc=13) for zkBTC deposits — this mints zkBTC
 * on-chain without needing real BTC. The commitment is computed on-chain
 * from the provided npk.
 *
 * Usage: bun run scripts/seed-stealth-deposits.ts <aegis:stealth_address>
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  buildAddDemoStealthData,
  ed25519GenerateKeyPair,
  initPoseidon,
  computeMPKSync,
  computeNPKSync,
  randomFieldElement,
  bigintTo32Bytes,
  decodeStealthMetaAddress,
  x25519Ecdh,
  encryptAmount,
} from "@aegis/sdk";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const state = JSON.parse(readFileSync("scripts/devnet-state.json", "utf8"));
const PROGRAM_ID = new PublicKey(state.aegisProgramId);
const POOL_STATE = new PublicKey(state.poolState);
const COMMITMENT_TREE = new PublicKey(state.commitmentTree);
const ZKBTC_MINT = new PublicKey(state.zkbtcMint);
const POOL_VAULT = new PublicKey(state.poolVault);
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// Load authority
const envContent = readFileSync("backend/.env.devnet", "utf8");
const match = envContent.match(/RELAYER_KEYPAIR=(\[[\d,\s]+\])/);
if (!match) throw new Error("RELAYER_KEYPAIR not found");
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(match[1])));

// Derive TokenConfig PDA for zkBTC
const [tokenConfigPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("token_config"), ZKBTC_MINT.toBuffer()],
  PROGRAM_ID,
);

// ---------------------------------------------------------------------------
// Parse stealth address
// ---------------------------------------------------------------------------

const stealthArg = process.argv[2];
if (!stealthArg) {
  console.error("Usage: bun run scripts/seed-stealth-deposits.ts <aegis:stealth_address>");
  process.exit(1);
}

const stealthMeta = decodeStealthMetaAddress(stealthArg);
if (!stealthMeta) {
  console.error("Invalid stealth address");
  process.exit(1);
}

const connection = new Connection(RPC_URL, "confirmed");
await initPoseidon();

console.log(`\n=== Seed Deposits to Stealth Address ===`);
console.log(`Program:   ${PROGRAM_ID.toBase58()}`);
console.log(`Authority: ${authority.publicKey.toBase58()}`);
console.log(`Stealth:   ${stealthArg.slice(0, 20)}...${stealthArg.slice(-10)}`);
console.log();

// ---------------------------------------------------------------------------
// Deposit definitions
// ---------------------------------------------------------------------------

const deposits = [
  { label: "zkBTC #1", amountSats: 50_000n, token: "BTC" },
  { label: "zkBTC #2", amountSats: 150_000n, token: "BTC" },
  { label: "zkBTC #3", amountSats: 25_000n, token: "BTC" },
  { label: "zkBTC #4", amountSats: 200_000n, token: "BTC" },
  { label: "zkBTC #5", amountSats: 75_000n, token: "BTC" },
  { label: "zkBTC #6", amountSats: 10_000n, token: "BTC" },
  { label: "zkBTC #7", amountSats: 500_000n, token: "BTC" },
  { label: "zkBTC #8", amountSats: 100_000n, token: "BTC" },
];

// ---------------------------------------------------------------------------
// Send deposits
// ---------------------------------------------------------------------------

for (let i = 0; i < deposits.length; i++) {
  const d = deposits[i];

  // Generate ephemeral key for this deposit
  const ephemeral = ed25519GenerateKeyPair();

  // Derive NPK for the recipient using their MPK from the stealth meta address
  const mpk = stealthMeta.mpk;
  // Convert mpk bytes to bigint
  let mpkBigint = 0n;
  for (const b of mpk) mpkBigint = (mpkBigint << 8n) | BigInt(b);

  const random = randomFieldElement();
  const npk = computeNPKSync(mpkBigint, random);
  const npkBytes = bigintTo32Bytes(npk);

  // Build instruction
  const ixData = buildAddDemoStealthData(ephemeral.pubKey, npkBytes, d.amountSats);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: POOL_STATE, isSigner: false, isWritable: true },
      { pubkey: COMMITMENT_TREE, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: ZKBTC_MINT, isSigner: false, isWritable: true },
      { pubkey: POOL_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenConfigPDA, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ixData),
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ix,
  );

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [authority], {
      commitment: "confirmed",
    });
    const btc = Number(d.amountSats) / 1e8;
    console.log(`[${i + 1}/${deposits.length}] ${d.label}: ${btc} BTC (${d.amountSats} sats) — ${sig.slice(0, 20)}...`);
  } catch (e: any) {
    console.error(`[${i + 1}/${deposits.length}] ${d.label} FAILED: ${e.message}`);
    if (e.logs) e.logs.slice(-3).forEach((l: string) => console.error(`  ${l}`));
  }

  if (i < deposits.length - 1) await new Promise((r) => setTimeout(r, 500));
}

console.log("\nDone. Backend indexer will pick up deposits automatically.");
console.log("Note: Demo instruction only supports zkBTC. For USDC/SOL deposits,");
console.log("use the shield flow from the frontend with a funded wallet.");
