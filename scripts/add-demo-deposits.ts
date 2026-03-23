#!/usr/bin/env bun
/**
 * Add demo stealth deposits to devnet.
 * Uses ADD_DEMO_STEALTH instruction (disc=13) — no real BTC needed.
 *
 * Usage: bun run scripts/add-demo-deposits.ts [count]
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
  generateBabyJubKeyPair,
  ed25519GenerateKeyPair,
  computeMPKSync,
  computeNPKSync,
  initPoseidon,
  randomFieldElement,
  bigintTo32Bytes,
} from "@aegis/sdk";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Config from devnet-state.json + .env.devnet
// ---------------------------------------------------------------------------

const state = JSON.parse(readFileSync("scripts/devnet-state.json", "utf8"));
const PROGRAM_ID = new PublicKey(state.aegisProgramId);
const POOL_STATE = new PublicKey(state.poolState);
const COMMITMENT_TREE = new PublicKey(state.commitmentTree);
const ZKBTC_MINT = new PublicKey(state.zkbtcMint);
const POOL_VAULT = new PublicKey(state.poolVault);
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

// Load authority keypair from RELAYER_KEYPAIR in .env.devnet
const envContent = readFileSync("backend/.env.devnet", "utf8");
const relayerMatch = envContent.match(/RELAYER_KEYPAIR=(\[[\d,\s]+\])/);
if (!relayerMatch) throw new Error("RELAYER_KEYPAIR not found in backend/.env.devnet");
const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(relayerMatch[1])));

// Token-2022 program
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// Derive TokenConfig PDA for zkBTC
const [tokenConfigPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("token_config"), ZKBTC_MINT.toBuffer()],
  PROGRAM_ID,
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const count = parseInt(process.argv[2] || "5", 10);
const connection = new Connection(RPC_URL, "confirmed");

console.log(`\n=== Add ${count} Demo Deposits to Devnet ===`);
console.log(`Program:    ${PROGRAM_ID.toBase58()}`);
console.log(`Authority:  ${authority.publicKey.toBase58()}`);
console.log(`RPC:        ${RPC_URL}`);
console.log();

// Init Poseidon for NPK computation
await initPoseidon();

// Demo amounts in sats (varied for realism)
const amounts = [50_000n, 100_000n, 25_000n, 200_000n, 10_000n, 75_000n, 150_000n, 30_000n];

for (let i = 0; i < count; i++) {
  const amountSats = amounts[i % amounts.length];

  // Generate keys
  const spending = generateBabyJubKeyPair();
  const ephemeral = ed25519GenerateKeyPair();

  // Compute MPK and NPK (matches on-chain commitment derivation)
  const nullifyingKey = randomFieldElement();
  const mpk = computeMPKSync(spending.pubKey.x, spending.pubKey.y, nullifyingKey);
  const random = randomFieldElement();
  const npk = computeNPKSync(mpk, random);
  const npkBytes = bigintTo32Bytes(npk);

  // Build instruction data
  const ixData = buildAddDemoStealthData(ephemeral.pubKey, npkBytes, amountSats);

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
    const btc = Number(amountSats) / 1e8;
    console.log(`[${i + 1}/${count}] Deposited ${btc} BTC (${amountSats} sats) — ${sig.slice(0, 20)}...`);
  } catch (e: any) {
    console.error(`[${i + 1}/${count}] Failed: ${e.message}`);
    if (e.logs) e.logs.forEach((l: string) => console.error(`  ${l}`));
  }

  // Small delay to avoid rate limiting
  if (i < count - 1) await new Promise((r) => setTimeout(r, 500));
}

console.log("\nDone. Backend indexer will pick up the deposits automatically.");
