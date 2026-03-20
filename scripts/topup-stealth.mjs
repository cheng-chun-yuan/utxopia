#!/usr/bin/env node
/**
 * Top up a stealth address with demo zkBTC via add_demo_stealth (disc=13).
 *
 * Usage:
 *   node scripts/topup-stealth.mjs <aegis_stealth_address> [amount_sats]
 *
 * Example:
 *   node scripts/topup-stealth.mjs aegis:9d2cb3fe...c1eb6 50000
 *
 * Default amount: 100,000 sats (0.001 BTC)
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
import * as crypto from "crypto";
import fs from "fs";
import path from "path";

// =============================================================================
// Config — reads from env or defaults to localnet config
// =============================================================================

// Try loading from localnet-state.json first, fall back to env vars
let _stateIds = {};
try {
  const _statePath = path.join(path.dirname(new URL(import.meta.url).pathname), "e2e", "localnet-state.json");
  _stateIds = JSON.parse(fs.readFileSync(_statePath, "utf-8"));
} catch {}
const AEGIS_PROGRAM_ID = new PublicKey(
  process.env.AEGIS_PROGRAM_ID || _stateIds.aegisProgramId || "7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ"
);
const ZKBTC_MINT = new PublicKey(
  process.env.ZKBTC_MINT || _stateIds.zkbtcMint || "G5CHaLkWjdUxxmnrVqNLQ29K7PoNwJAzvVT11jjkdGKC"
);
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RPC_URL = process.env.RPC_URL || "http://localhost:8899";

// Load authority keypair
const keypairPath = process.env.KEYPAIR_PATH || path.join(process.env.HOME, ".config/solana/id.json");
const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const authority = Keypair.fromSecretKey(Uint8Array.from(keypairData));

// =============================================================================
// Parse stealth address
// =============================================================================

function parseStealthAddress(addr) {
  // Format: aegis:<hex> where hex = spendingPubKey(32) + viewingPubKey(32) + mpk(32) = 96 bytes = 192 hex
  if (!addr.startsWith("aegis:")) {
    throw new Error("Invalid stealth address format — must start with 'aegis:'");
  }
  const hex = addr.slice(6);
  if (hex.length !== 192) {
    throw new Error(`Invalid stealth address length — expected 192 hex chars, got ${hex.length}`);
  }
  const bytes = Buffer.from(hex, "hex");
  return {
    spendingPubKey: bytes.slice(0, 32),  // Baby Jubjub compressed (EdDSA-Poseidon)
    viewingPubKey: bytes.slice(32, 64),   // Ed25519
    mpk: bytes.slice(64, 96),             // Poseidon(spendPubX, spendPubY, nullifyingKey)
  };
}

// =============================================================================
// Poseidon (circomlibjs)
// =============================================================================

async function loadPoseidon() {
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  return {
    hash: (inputs) => F.toObject(poseidon(inputs)),
    F,
  };
}

function bigintToBytes32BE(n) {
  const buf = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}

// =============================================================================
// X25519 ECDH (for stealth derivation)
// =============================================================================

function ed25519PubToX25519(ed25519Pub) {
  // Use Node.js crypto to convert Ed25519 pub → X25519
  const keyObj = crypto.createPublicKey({
    key: Buffer.concat([
      // Ed25519 DER prefix
      Buffer.from("302a300506032b6570032100", "hex"),
      ed25519Pub,
    ]),
    format: "der",
    type: "spki",
  });
  const x25519Key = crypto.convertKey(keyObj, "X25519");
  return x25519Key.export({ type: "spki", format: "der" }).slice(-32);
}

function x25519Ecdh(privKey, pubKeyBytes) {
  const privKeyObj = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b656e04220420", "hex"),
      privKey,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const pubKeyObj = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b656e032100", "hex"),
      pubKeyBytes,
    ]),
    format: "der",
    type: "spki",
  });
  return crypto.diffieHellman({ privateKey: privKeyObj, publicKey: pubKeyObj });
}

// =============================================================================
// Helpers
// =============================================================================

function pda(seeds, programId) {
  return PublicKey.findProgramAddressSync(
    seeds.map(s => typeof s === "string" ? Buffer.from(s) : s),
    programId
  );
}

function ata(mint, owner) {
  const [addr] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM
  );
  return addr;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: node scripts/topup-stealth.mjs <aegis:stealth_address> [amount_sats]");
    process.exit(1);
  }

  const stealthAddr = args[0];
  const amountSats = BigInt(args[1] || "100000"); // default 100k sats

  console.log("=== Top-up Stealth Address ===");
  console.log("Address:", stealthAddr.slice(0, 30) + "...");
  console.log("Amount:", Number(amountSats).toLocaleString(), "sats");
  console.log("Program:", AEGIS_PROGRAM_ID.toBase58());
  console.log("RPC:", RPC_URL);
  console.log();

  // Parse stealth address
  const meta = parseStealthAddress(stealthAddr);
  const mpk = BigInt("0x" + meta.mpk.toString("hex"));
  console.log("Spending pub:", meta.spendingPubKey.toString("hex").slice(0, 16) + "...");
  console.log("Viewing pub:", meta.viewingPubKey.toString("hex").slice(0, 16) + "...");
  console.log("MPK:", mpk.toString(16).slice(0, 16) + "...");

  // Load Poseidon
  const poseidon = await loadPoseidon();

  // Generate ephemeral Ed25519 keypair
  const ephKeyPair = crypto.generateKeyPairSync("ed25519");
  const ephPubDer = ephKeyPair.publicKey.export({ type: "spki", format: "der" });
  const ephPub = ephPubDer.slice(-32);

  // ECDH: ephemeral × viewingPub → shared secret
  let viewingPubX25519;
  try {
    viewingPubX25519 = ed25519PubToX25519(meta.viewingPubKey);
  } catch {
    viewingPubX25519 = meta.viewingPubKey;
  }

  let ephPrivX25519;
  try {
    const ephX25519 = crypto.convertKey(ephKeyPair.privateKey, "X25519");
    ephPrivX25519 = ephX25519.export({ type: "pkcs8", format: "der" }).slice(-32);
  } catch {
    const ephPrivDer = ephKeyPair.privateKey.export({ type: "pkcs8", format: "der" });
    ephPrivX25519 = ephPrivDer.slice(-32);
  }

  const sharedSecret = x25519Ecdh(ephPrivX25519, viewingPubX25519);

  // Derive stealth scalar
  const domain = Buffer.from("Aegis-stealth-v1");
  const secretBuf = Buffer.concat([sharedSecret, domain]);
  const hash = crypto.createHash("sha256").update(secretBuf).digest();
  const BN254_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  let stealthScalar = BigInt("0x" + hash.toString("hex")) % BN254_FIELD;

  // NPK = Poseidon(MPK, stealthScalar)
  const npk = poseidon.hash([mpk, stealthScalar]);
  const npkBytes = bigintToBytes32BE(npk);
  console.log("NPK:", npk.toString(16).slice(0, 16) + "...");

  // Read on-chain token_id from TokenConfig
  const conn = new Connection(RPC_URL, "confirmed");
  const [tokenConfigPda] = pda(["token_config", ZKBTC_MINT.toBuffer()], AEGIS_PROGRAM_ID);
  const tcInfo = await conn.getAccountInfo(tokenConfigPda);
  if (!tcInfo) throw new Error("TokenConfig not found — run init-devnet.mjs first");
  const tokenIdBytes = tcInfo.data.slice(34, 66);
  const tokenId = BigInt("0x" + Buffer.from(tokenIdBytes).toString("hex"));
  console.log("Token ID:", tokenId.toString(16).slice(0, 16) + "...");

  // Compute expected commitment (for verification)
  const commitment = poseidon.hash([npk, tokenId, amountSats]);
  console.log("Commitment:", commitment.toString(16).slice(0, 16) + "...");

  // Derive PDAs
  const [poolState] = pda(["pool_state"], AEGIS_PROGRAM_ID);
  const [commitmentTree] = pda(["commitment_tree"], AEGIS_PROGRAM_ID);
  const poolVault = ata(ZKBTC_MINT, poolState);

  // Build add_demo_stealth instruction (disc=13)
  // Data: ephemeral_pub(32) + npk(32) + amount_sats(8) = 72 bytes + 1 disc
  const data = Buffer.alloc(73);
  data[0] = 13; // ADD_DEMO_STEALTH
  Buffer.from(ephPub).copy(data, 1);
  Buffer.from(npkBytes).copy(data, 33);
  data.writeBigUInt64LE(amountSats, 65);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ZKBTC_MINT, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda, isSigner: false, isWritable: false },
    ],
    programId: AEGIS_PROGRAM_ID,
    data,
  });

  console.log("\nSending demo deposit...");
  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });

  console.log("\n========================================");
  console.log("TOP-UP COMPLETE");
  console.log("========================================");
  console.log("Tx:", sig);
  console.log("Amount:", Number(amountSats).toLocaleString(), "sats");
  console.log("Recipient:", stealthAddr.slice(0, 30) + "...");
  console.log(`Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

main().catch(err => {
  console.error("Error:", err.message);
  if (err.logs) err.logs.forEach(l => console.error("  ", l));
  process.exit(1);
});
