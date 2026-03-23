#!/usr/bin/env node
/**
 * Initialize BTC Light Client on testnet4 (or regtest)
 *
 * Fetches the current tip from mempool.space, uses tip-10 as genesis block,
 * and sends the initialize instruction to the BTC Light Client program.
 *
 * Env vars:
 *   BTC_LIGHT_CLIENT_PROGRAM_ID (required)
 *   RPC_URL (default: https://api.devnet.solana.com)
 *   KEYPAIR_PATH (default: ~/.config/solana/johnny.json)
 *   BTC_API_URL (default: https://mempool.space/testnet4/api)
 *   BTC_NETWORK_ID (default: 2, 0=mainnet, 1=testnet3, 2=testnet4, 3=regtest)
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
import fs from "fs";
import path from "path";

// =============================================================================
// Config
// =============================================================================

const BTCLC_PROGRAM_ID = new PublicKey(
  process.env.BTC_LIGHT_CLIENT_PROGRAM_ID || (() => { throw new Error("BTC_LIGHT_CLIENT_PROGRAM_ID required"); })()
);
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const BTC_API_URL = process.env.BTC_API_URL || "https://mempool.space/testnet4/api";
const BTC_NETWORK_ID = parseInt(process.env.BTC_NETWORK_ID || "2", 10); // 2 = testnet4

const keypairPath = process.env.KEYPAIR_PATH || path.join(process.env.HOME, ".config/solana/johnny.json");
const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const authority = Keypair.fromSecretKey(Uint8Array.from(keypairData));

// =============================================================================
// Helpers
// =============================================================================

function hexToBytesReversed(hex) {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    buf[31 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

function deriveLightClientPDA() {
  return PublicKey.findProgramAddressSync([Buffer.from("btc_light_client")], BTCLC_PROGRAM_ID);
}

function deriveHeightIndexPDA(height) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(height));
  return PublicKey.findProgramAddressSync([Buffer.from("height_index"), buf], BTCLC_PROGRAM_ID);
}

function deriveBlockHeaderPDA(blockHash) {
  return PublicKey.findProgramAddressSync([Buffer.from("block"), blockHash], BTCLC_PROGRAM_ID);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");

  console.log("BTC Light Client:", BTCLC_PROGRAM_ID.toBase58());
  console.log("Authority:", authority.publicKey.toBase58());
  console.log("BTC API:", BTC_API_URL);

  // Check if already initialized
  const [lightClientPda] = deriveLightClientPDA();
  console.log("Light Client PDA:", lightClientPda.toBase58());

  const existing = await conn.getAccountInfo(lightClientPda);
  if (existing && existing.data && existing.data.length > 0 && existing.data[0] === 0x01) {
    console.log("BTC Light Client already initialized — skipping");
    return;
  }

  // Fetch testnet4 tip
  console.log("\nFetching testnet4 tip...");
  const tipRes = await fetch(`${BTC_API_URL}/blocks/tip/height`);
  if (!tipRes.ok) throw new Error(`Failed to fetch tip: ${tipRes.statusText}`);
  const tipHeight = parseInt(await tipRes.text(), 10);

  const startHeight = tipHeight - 10;
  console.log(`Tip: ${tipHeight}, Genesis: ${startHeight}`);

  // Fetch block hash
  const hashRes = await fetch(`${BTC_API_URL}/block-height/${startHeight}`);
  if (!hashRes.ok) throw new Error(`Failed to fetch block hash: ${hashRes.statusText}`);
  const blockHashHex = await hashRes.text();
  console.log(`Block hash: ${blockHashHex.slice(0, 16)}...`);

  // Convert to LE bytes
  const blockHashBytes = hexToBytesReversed(blockHashHex);

  // Derive PDAs
  const [heightIndexPda] = deriveHeightIndexPDA(startHeight);
  const [blockHeaderPda] = deriveBlockHeaderPDA(blockHashBytes);

  // Build initialize instruction (disc=0)
  // Data: disc(1) + height(8) + block_hash(32) + network(1) = 42 bytes
  const data = Buffer.alloc(42);
  data[0] = 0; // INITIALIZE
  data.writeBigUInt64LE(BigInt(startHeight), 1);
  blockHashBytes.copy(data, 9);
  data[41] = BTC_NETWORK_ID;

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: lightClientPda, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: heightIndexPda, isSigner: false, isWritable: true },
      { pubkey: blockHeaderPda, isSigner: false, isWritable: true },
    ],
    programId: BTCLC_PROGRAM_ID,
    data,
  });

  console.log("\nSending initialize transaction...");
  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  console.log(`Initialized! Signature: ${sig}`);
  console.log(`Start height: ${startHeight}`);
  console.log(`Light Client PDA: ${lightClientPda.toBase58()}`);
}

main().catch(err => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
