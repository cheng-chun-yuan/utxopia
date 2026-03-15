#!/usr/bin/env node
/**
 * Propose pool parameter update (48h timelock)
 *
 * Sets service_fee_base=2000 sats, service_fee_bps=30 (0.3%)
 * while keeping existing min/max deposit values.
 *
 * Usage: node scripts/propose-pool-update.mjs
 *
 * After 48h, execute with: node scripts/execute-pool-update.mjs
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";

// =============================================================================
// Config
// =============================================================================

const AEGIS_PROGRAM_ID = new PublicKey(
  process.env.AEGIS_PROGRAM_ID || "7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ"
);
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

// Load keypair
const keypairPath = process.env.KEYPAIR_PATH || path.join(process.env.HOME, ".config/solana/johnny.json");
const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const authority = Keypair.fromSecretKey(Uint8Array.from(keypairData));

// Pool state PDA
const [poolStatePDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool_state")],
  AEGIS_PROGRAM_ID
);

console.log("Authority:", authority.publicKey.toBase58());
console.log("Program:", AEGIS_PROGRAM_ID.toBase58());
console.log("Pool State:", poolStatePDA.toBase58());

// =============================================================================
// Read current pool state to preserve min/max deposit
// =============================================================================

const connection = new Connection(RPC_URL, "confirmed");

const poolAccount = await connection.getAccountInfo(poolStatePDA);
if (!poolAccount) {
  console.error("Pool state PDA not found!");
  process.exit(1);
}

const data = poolAccount.data;
// Offsets from pool.rs layout:
// min_deposit: 172..180, max_deposit: 180..188
// service_fee_base: 196..204, service_fee_bps: 244..246
const currentMinDeposit = data.readBigUInt64LE(172);
const currentMaxDeposit = data.readBigUInt64LE(180);
const currentFeeBase = data.readBigUInt64LE(196);
const currentFeeBps = data.readUInt16LE(244);

console.log("\nCurrent pool config:");
console.log("  min_deposit:", currentMinDeposit.toString(), "sats");
console.log("  max_deposit:", currentMaxDeposit.toString(), "sats");
console.log("  service_fee_base:", currentFeeBase.toString(), "sats");
console.log("  service_fee_bps:", currentFeeBps, `(${(currentFeeBps / 100).toFixed(1)}%)`);

// =============================================================================
// Propose update
// =============================================================================

// New values
const NEW_SERVICE_FEE_BASE = 2000n;  // 2000 sats
const NEW_SERVICE_FEE_BPS = 30;      // 0.3%

console.log("\nProposing update:");
console.log("  service_fee_base:", NEW_SERVICE_FEE_BASE.toString(), "sats");
console.log("  service_fee_bps:", NEW_SERVICE_FEE_BPS, `(${(NEW_SERVICE_FEE_BPS / 100).toFixed(1)}%)`);
console.log("  min_deposit:", currentMinDeposit.toString(), "sats (unchanged)");
console.log("  max_deposit:", currentMaxDeposit.toString(), "sats (unchanged)");

// Build instruction data:
// disc(1) + min_deposit(8) + max_deposit(8) + service_fee_base(8) + service_fee_bps(2) = 27 bytes
const ixData = Buffer.alloc(27);
ixData[0] = 21; // PROPOSE_POOL_UPDATE discriminator
ixData.writeBigUInt64LE(currentMinDeposit, 1);
ixData.writeBigUInt64LE(currentMaxDeposit, 9);
ixData.writeBigUInt64LE(NEW_SERVICE_FEE_BASE, 17);
ixData.writeUInt16LE(NEW_SERVICE_FEE_BPS, 25);

const ix = new TransactionInstruction({
  programId: AEGIS_PROGRAM_ID,
  keys: [
    { pubkey: poolStatePDA, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
  ],
  data: ixData,
});

const tx = new Transaction().add(ix);

try {
  const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
  console.log("\nProposal submitted! Signature:", sig);
  console.log("\nTimelock: 48 hours from now.");
  console.log("Run `node scripts/execute-pool-update.mjs` after the timelock expires.");
} catch (err) {
  console.error("Failed to submit proposal:", err.message);
  process.exit(1);
}
