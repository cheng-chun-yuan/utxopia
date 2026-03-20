#!/usr/bin/env node
/**
 * Top up a stealth address with all token types using proper ECDH stealth protocol.
 *
 * Usage:
 *   node scripts/topup-all.mjs <aegis:stealth_address>
 */

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
} from "@solana/spl-token";
import * as crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, "e2e", "localnet-state.json"), "utf-8"));
const AEGIS = new PublicKey(state.aegisProgramId);
const RPC_URL = process.env.RPC_URL || "http://localhost:8899";
const conn = new Connection(RPC_URL, "confirmed");
const authority = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".config/solana/id.json"), "utf-8"))
));

const BN254_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ─── Poseidon ────────────────────────────────────────────────────────────────

let poseidonHash;
async function initPoseidon() {
  const { buildPoseidon } = await import("circomlibjs");
  const p = await buildPoseidon();
  const F = p.F;
  poseidonHash = (inputs) => F.toObject(p(inputs));
}

function bigintToBytes32BE(n) {
  const buf = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { buf[i] = Number(n & 0xffn); n >>= 8n; }
  return buf;
}

// ─── Stealth ECDH (using @noble/curves, same as SDK) ─────────────────────────

function ed25519PubToX25519(ed25519Pub) {
  const keyObj = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), ed25519Pub]),
    format: "der", type: "spki",
  });
  try {
    const x25519Key = crypto.convertKey(keyObj, "X25519");
    return x25519Key.export({ type: "spki", format: "der" }).slice(-32);
  } catch {
    return ed25519Pub; // fallback
  }
}

function x25519Ecdh(privKey, pubKeyBytes) {
  const privKeyObj = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), privKey]),
    format: "der", type: "pkcs8",
  });
  const pubKeyObj = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), pubKeyBytes]),
    format: "der", type: "spki",
  });
  return crypto.diffieHellman({ privateKey: privKeyObj, publicKey: pubKeyObj });
}

function stealthDerive(viewingPubKey, mpk) {
  // Generate Ed25519 ephemeral keypair
  const ephKeyPair = crypto.generateKeyPairSync("ed25519");
  const ephPubDer = ephKeyPair.publicKey.export({ type: "spki", format: "der" });
  const ephPub = ephPubDer.slice(-32);

  // X25519 ECDH: ephemeral × viewingPub → shared secret
  const viewingPubX25519 = ed25519PubToX25519(Buffer.from(viewingPubKey));
  let ephPrivX25519;
  try {
    const ephX25519 = crypto.convertKey(ephKeyPair.privateKey, "X25519");
    ephPrivX25519 = ephX25519.export({ type: "pkcs8", format: "der" }).slice(-32);
  } catch {
    ephPrivX25519 = ephKeyPair.privateKey.export({ type: "pkcs8", format: "der" }).slice(-32);
  }
  const sharedSecret = x25519Ecdh(ephPrivX25519, viewingPubX25519);

  // Derive stealth scalar (same as SDK's deriveStealthScalar)
  const domain = Buffer.from("Aegis-stealth-v1");
  const secretBuf = Buffer.concat([Buffer.from(sharedSecret), domain]);
  const hash = crypto.createHash("sha256").update(secretBuf).digest();
  const stealthScalar = BigInt("0x" + hash.toString("hex")) % BN254_FIELD;

  // NPK = Poseidon(MPK, stealthScalar)
  const npk = poseidonHash([mpk, stealthScalar]);

  return { ephPub: Buffer.from(ephPub), npk, npkBytes: bigintToBytes32BE(npk) };
}

// ─── PDA / ATA helpers ───────────────────────────────────────────────────────

function pda(seeds) {
  return PublicKey.findProgramAddressSync(
    seeds.map(s => typeof s === "string" ? Buffer.from(s) : s), AEGIS
  );
}

function ata(mint, owner) {
  return getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
}

// ─── Deposit functions ───────────────────────────────────────────────────────

async function demoDeposit(viewingPub, mpk, mint, vault, tokenConfigPda, amountSats, label) {
  const { ephPub, npkBytes } = stealthDerive(viewingPub, mpk);
  const [poolState] = pda(["pool_state"]);
  const [commitmentTree] = pda(["commitment_tree"]);

  const data = Buffer.alloc(73);
  data[0] = 13; // ADD_DEMO_STEALTH
  ephPub.copy(data, 1);
  Buffer.from(npkBytes).copy(data, 33);
  data.writeBigUInt64LE(amountSats, 65);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda, isSigner: false, isWritable: false },
    ],
    programId: AEGIS,
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  console.log(`  ✓ ${label} — ${sig.slice(0, 20)}...`);
}

async function shieldSPL(viewingPub, mpk, mint, vault, amount, label) {
  const { ephPub, npkBytes } = stealthDerive(viewingPub, mpk);
  const [poolState] = pda(["pool_state"]);
  const [commitmentTree] = pda(["commitment_tree"]);
  const [tokenConfig] = pda(["token_config", mint.toBuffer()]);
  const userAta = ata(mint, authority.publicKey);

  const data = Buffer.alloc(73);
  data[0] = 29; // SHIELD
  data.writeBigUInt64LE(amount, 1);
  Buffer.from(npkBytes).copy(data, 9);
  Buffer.from(ephPub).copy(data, 41);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: poolState, isSigner: false, isWritable: false },
      { pubkey: tokenConfig, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: AEGIS,
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  console.log(`  ✓ ${label} — ${sig.slice(0, 20)}...`);
}

async function mintTokens(mint, amount, label) {
  const userAta = ata(mint, authority.publicKey);
  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(
    authority.publicKey, userAta, authority.publicKey, mint, TOKEN_2022_PROGRAM_ID,
  ));
  tx.add(createMintToInstruction(mint, userAta, authority.publicKey, Number(amount), [], TOKEN_2022_PROGRAM_ID));
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  console.log(`  Minted ${label}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const stealthAddr = args[0] || "aegis:9d2cb3fea6912aeb783760f47367c53f2fb2ed7240c98a99786172982950fe988f45b56ecd1d6d02f5007accc9fa430bc4dc91f1fabe1d37977cb773468ef3451b592c4e3881b34572c0d83baacfda725f04ac6810dbaf7227e7f69f784c1eb6";

  if (!stealthAddr.startsWith("aegis:") || stealthAddr.slice(6).length !== 192)
    throw new Error("Invalid aegis: address");

  const bytes = Buffer.from(stealthAddr.slice(6), "hex");
  const viewingPub = new Uint8Array(bytes.slice(32, 64));
  const mpk = BigInt("0x" + bytes.slice(64, 96).toString("hex"));

  await initPoseidon();

  console.log("=== Top-up All Tokens (proper ECDH) ===");
  console.log("Recipient:", stealthAddr.slice(0, 30) + "...");
  console.log("Program:", AEGIS.toBase58());
  console.log();

  const zkbtcMint = new PublicKey(state.zkbtcMint);
  const [zkbtcTokenConfig] = pda(["token_config", zkbtcMint.toBuffer()]);

  // 1. zkBTC demo deposits
  console.log("─── zkBTC (demo) ───");
  await demoDeposit(viewingPub, mpk, zkbtcMint, new PublicKey(state.poolVault), zkbtcTokenConfig, 50_000n, "50,000 sats");
  await demoDeposit(viewingPub, mpk, zkbtcMint, new PublicKey(state.poolVault), zkbtcTokenConfig, 100_000n, "100,000 sats");

  // 2. tUSDC real shield
  if (state.tUsdcMint && state.tUsdcVault) {
    console.log("\n─── tUSDC (real shield) ───");
    const usdcMint = new PublicKey(state.tUsdcMint);
    await mintTokens(usdcMint, 5_000_000_000, "5000 tUSDC");
    await shieldSPL(viewingPub, mpk, usdcMint, new PublicKey(state.tUsdcVault), 2_000_000_000n, "2,000 USDC");
    await shieldSPL(viewingPub, mpk, usdcMint, new PublicKey(state.tUsdcVault), 500_000_000n, "500 USDC");
  }

  // 3. tWSOL real shield
  if (state.tWsolMint && state.tWsolVault) {
    console.log("\n─── tWSOL (real shield) ───");
    const wsolMint = new PublicKey(state.tWsolMint);
    await mintTokens(wsolMint, 500_000_000, "0.5 tWSOL");
    await shieldSPL(viewingPub, mpk, wsolMint, new PublicKey(state.tWsolVault), 200_000_000n, "0.2 SOL");
    await shieldSPL(viewingPub, mpk, wsolMint, new PublicKey(state.tWsolVault), 50_000_000n, "0.05 SOL");
  }

  console.log("\n========================================");
  console.log("ALL TOKENS TOPPED UP (scannable via ECDH)");
  console.log("========================================");
}

main().catch(err => {
  console.error("Error:", err.message || err);
  console.error(err.stack);
  if (err.logs) err.logs.forEach(l => console.error("  ", l));
  process.exit(1);
});
