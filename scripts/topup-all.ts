#!/usr/bin/env bun
/**
 * Top up a stealth address using the SDK's createStealthDepositWithKeys
 * (same ECDH as the wallet scanner).
 *
 * Usage: bun run scripts/topup-all.ts [aegis:address]
 */

import {
  initPoseidon,
  createStealthDepositWithKeys,
  decodeStealthMetaAddress,
  computeTokenId,
} from "@aegis/sdk";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  Connection,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "../..");
const state = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/e2e/localnet-state.json"), "utf-8"));
const AEGIS = new PublicKey(state.aegisProgramId);
const conn = new Connection("http://localhost:8899", "confirmed");
const authority = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf-8"))
));

function pda(seeds: (string | Uint8Array)[]) {
  return PublicKey.findProgramAddressSync(
    seeds.map(s => typeof s === "string" ? Buffer.from(s) : s), AEGIS
  );
}

async function readTokenId(mint: PublicKey): Promise<bigint> {
  return computeTokenId(mint.toBytes());
}

async function demoDeposit(meta: ReturnType<typeof decodeStealthMetaAddress>, tokenId: bigint, mint: PublicKey, vault: PublicKey, amountSats: bigint, label: string) {
  const stealth = await createStealthDepositWithKeys(meta, amountSats, tokenId);
  const [poolState] = pda(["pool_state"]);
  const [commitmentTree] = pda(["commitment_tree"]);
  const [tokenConfig] = pda(["token_config", mint.toBuffer()]);

  // Build add_demo_stealth (disc=13): ephemeralPub(32) + npk(32) + amount(8) = 72
  const data = Buffer.alloc(73);
  data[0] = 13;
  Buffer.from(stealth.ephemeralPub).copy(data, 1);
  // npk bytes from stealth output
  const npkBytes = Buffer.alloc(32);
  let npk = stealth.stealthPubKeyX;
  for (let i = 31; i >= 0; i--) { npkBytes[i] = Number(npk & 0xffn); npk >>= 8n; }
  npkBytes.copy(data, 33);
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
      { pubkey: tokenConfig, isSigner: false, isWritable: false },
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

async function shieldSPL(meta: ReturnType<typeof decodeStealthMetaAddress>, tokenId: bigint, mint: PublicKey, vault: PublicKey, amount: bigint, label: string) {
  const stealth = await createStealthDepositWithKeys(meta, amount, tokenId);
  const [poolState] = pda(["pool_state"]);
  const [commitmentTree] = pda(["commitment_tree"]);
  const [tokenConfig] = pda(["token_config", mint.toBuffer()]);
  const userAta = getAssociatedTokenAddressSync(mint, authority.publicKey, false, TOKEN_2022_PROGRAM_ID);

  // Build shield (disc=29): amount(8) + npk(32) + ephemeralPub(32) = 72
  const data = Buffer.alloc(73);
  data[0] = 29;
  data.writeBigUInt64LE(amount, 1);
  const npkBytes = Buffer.alloc(32);
  let npk = stealth.stealthPubKeyX;
  for (let i = 31; i >= 0; i--) { npkBytes[i] = Number(npk & 0xffn); npk >>= 8n; }
  npkBytes.copy(data, 9);
  Buffer.from(stealth.ephemeralPub).copy(data, 41);

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

async function mintTokens(mint: PublicKey, amount: number, label: string) {
  const userAta = getAssociatedTokenAddressSync(mint, authority.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, userAta, authority.publicKey, mint, TOKEN_2022_PROGRAM_ID));
  tx.add(createMintToInstruction(mint, userAta, authority.publicKey, amount, [], TOKEN_2022_PROGRAM_ID));
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  console.log(`  Minted ${label}`);
}

async function main() {
  const addr = process.argv[2] || "aegis:9d2cb3fea6912aeb783760f47367c53f2fb2ed7240c98a99786172982950fe988f45b56ecd1d6d02f5007accc9fa430bc4dc91f1fabe1d37977cb773468ef3451b592c4e3881b34572c0d83baacfda725f04ac6810dbaf7227e7f69f784c1eb6";

  await initPoseidon();
  const meta = decodeStealthMetaAddress(addr);

  console.log("=== Top-up All Tokens (SDK ECDH) ===");
  console.log("Recipient:", addr.slice(0, 30) + "...");
  console.log("Program:", AEGIS.toBase58());
  console.log();

  const zkbtcMint = new PublicKey(state.zkbtcMint);
  const zkbtcVault = new PublicKey(state.poolVault);
  const zkbtcTokenId = await readTokenId(zkbtcMint);

  // 1. zkBTC
  console.log("─── zkBTC (demo) ───");
  await demoDeposit(meta, zkbtcTokenId, zkbtcMint, zkbtcVault, 50_000n, "50,000 sats");
  await demoDeposit(meta, zkbtcTokenId, zkbtcMint, zkbtcVault, 100_000n, "100,000 sats");

  // 2. tUSDC
  if (state.tUsdcMint) {
    console.log("\n─── tUSDC (real shield) ───");
    const usdcMint = new PublicKey(state.tUsdcMint);
    const usdcVault = new PublicKey(state.tUsdcVault);
    const usdcTokenId = await readTokenId(usdcMint);
    await mintTokens(usdcMint, 5_000_000_000, "5000 tUSDC");
    await shieldSPL(meta, usdcTokenId, usdcMint, usdcVault, 2_000_000_000n, "2,000 USDC");
    await shieldSPL(meta, usdcTokenId, usdcMint, usdcVault, 500_000_000n, "500 USDC");
  }

  // 3. tWSOL
  if (state.tWsolMint) {
    console.log("\n─── tWSOL (real shield) ───");
    const wsolMint = new PublicKey(state.tWsolMint);
    const wsolVault = new PublicKey(state.tWsolVault);
    const wsolTokenId = await readTokenId(wsolMint);
    await mintTokens(wsolMint, 500_000_000, "0.5 tWSOL");
    await shieldSPL(meta, wsolTokenId, wsolMint, wsolVault, 200_000_000n, "0.2 SOL");
    await shieldSPL(meta, wsolTokenId, wsolMint, wsolVault, 50_000_000n, "0.05 SOL");
  }

  console.log("\n========================================");
  console.log("ALL DONE — scannable with SDK ECDH");
  console.log("========================================");
}

main().catch(err => {
  console.error("Error:", err.message || err);
  console.error(err.stack);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
