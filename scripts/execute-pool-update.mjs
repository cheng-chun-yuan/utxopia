#!/usr/bin/env node
/**
 * Execute a pending pool parameter update after timelock expires.
 *
 * Permissionless — anyone can call this once 48h has passed.
 *
 * Usage: node scripts/execute-pool-update.mjs
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

const keypairPath = process.env.KEYPAIR_PATH || path.join(process.env.HOME, ".config/solana/johnny.json");
const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));

const [poolStatePDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool_state")],
  AEGIS_PROGRAM_ID
);

console.log("Payer:", payer.publicKey.toBase58());
console.log("Pool State:", poolStatePDA.toBase58());

// =============================================================================
// Check pending proposal
// =============================================================================

const connection = new Connection(RPC_URL, "confirmed");

const poolAccount = await connection.getAccountInfo(poolStatePDA);
if (!poolAccount) {
  console.error("Pool state PDA not found!");
  process.exit(1);
}

const data = poolAccount.data;
// pending_execute_after: offset 236..244
const pendingExecuteAfter = Number(data.readBigInt64LE(236));
const pendingFeeBase = data.readBigUInt64LE(228);
const pendingFeeBps = data.readUInt16LE(246);

if (pendingExecuteAfter === 0) {
  console.log("No pending proposal found.");
  process.exit(0);
}

const now = Math.floor(Date.now() / 1000);
const remaining = pendingExecuteAfter - now;

console.log("\nPending proposal:");
console.log("  pending_service_fee_base:", pendingFeeBase.toString(), "sats");
console.log("  pending_service_fee_bps:", pendingFeeBps);
console.log("  execute_after:", new Date(pendingExecuteAfter * 1000).toISOString());

if (remaining > 0) {
  const hours = Math.floor(remaining / 3600);
  const mins = Math.floor((remaining % 3600) / 60);
  console.log(`\nTimelock not expired yet. ${hours}h ${mins}m remaining.`);
  process.exit(1);
}

console.log("\nTimelock expired. Executing...");

// =============================================================================
// Execute
// =============================================================================

// disc(1) = 22 (EXECUTE_POOL_UPDATE)
const ixData = Buffer.from([22]);

const ix = new TransactionInstruction({
  programId: AEGIS_PROGRAM_ID,
  keys: [
    { pubkey: poolStatePDA, isSigner: false, isWritable: true },
  ],
  data: ixData,
});

const tx = new Transaction().add(ix);

try {
  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  console.log("Executed! Signature:", sig);

  // Verify new values
  const updated = await connection.getAccountInfo(poolStatePDA);
  const d = updated.data;
  console.log("\nNew pool config:");
  console.log("  service_fee_base:", d.readBigUInt64LE(196).toString(), "sats");
  console.log("  service_fee_bps:", d.readUInt16LE(244));
} catch (err) {
  console.error("Failed to execute:", err.message);
  process.exit(1);
}
