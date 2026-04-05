#!/usr/bin/env bun
/**
 * Top up a stealth address with all registered tokens.
 *
 * Usage:
 *   PRIVACY_COIN_NETWORK=devnet bun run scripts/topup-all.ts pcoin:<address>
 *   bun run scripts/topup-all.ts pcoin:<address>   # defaults to devnet
 */

import {
  initPoseidon,
  createStealthDepositWithKeys,
  decodeStealthMetaAddress,
  computeTokenId,
  buildShieldInstructionData,
  bigintTo32Bytes,
} from "@privacy-coin/sdk";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { setupScript } from "./lib/common.ts";

const network = (process.env.PRIVACY_COIN_NETWORK || "devnet") as "localnet" | "devnet";
const { conn, authority, programId: PRIVACY_COIN, state } = setupScript(network);

// Derive constant PDAs once
const [poolState] = PublicKey.findProgramAddressSync([Buffer.from("pool_state")], PRIVACY_COIN);
const [commitmentTree] = PublicKey.findProgramAddressSync([Buffer.from("commitment_tree")], PRIVACY_COIN);

function tokenConfigPDA(mint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("token_config"), mint.toBuffer()], PRIVACY_COIN)[0];
}

function shieldKeys(userAta: PublicKey, vault: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
  return [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: userAta, isSigner: false, isWritable: true },
    { pubkey: poolState, isSigner: false, isWritable: false },
    { pubkey: tokenConfigPDA(mint), isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: commitmentTree, isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ];
}

function buildShieldData(stealth: { stealthPubKeyX: bigint; ephemeralPub: Uint8Array }, amount: bigint): Buffer {
  return Buffer.from(buildShieldInstructionData({
    amount,
    npk: bigintTo32Bytes(stealth.stealthPubKeyX),
    ephemeralPub: stealth.ephemeralPub,
  }));
}

async function shieldToken2022(
  meta: ReturnType<typeof decodeStealthMetaAddress>,
  mint: PublicKey, vault: PublicKey, amount: bigint, label: string,
) {
  const tokenId = computeTokenId(mint.toBytes());
  const stealth = await createStealthDepositWithKeys(meta, amount, tokenId);
  const userAta = getAssociatedTokenAddressSync(mint, authority.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const tx = new Transaction().add(new TransactionInstruction({
    keys: shieldKeys(userAta, vault, mint, TOKEN_2022_PROGRAM_ID),
    programId: PRIVACY_COIN,
    data: buildShieldData(stealth, amount),
  }));
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  console.log(`  ✓ ${label} — ${sig.slice(0, 20)}...`);
}

async function shieldNativeSOL(
  meta: ReturnType<typeof decodeStealthMetaAddress>,
  vault: PublicKey, amount: bigint, label: string,
) {
  const tokenId = computeTokenId(NATIVE_MINT.toBytes());
  const stealth = await createStealthDepositWithKeys(meta, amount, tokenId);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, authority.publicKey, false, TOKEN_PROGRAM_ID);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, wsolAta, authority.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: wsolAta, lamports: Number(amount) }),
    createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID),
    new TransactionInstruction({
      keys: shieldKeys(wsolAta, vault, NATIVE_MINT, TOKEN_PROGRAM_ID),
      programId: PRIVACY_COIN,
      data: buildShieldData(stealth, amount),
    }),
    createCloseAccountInstruction(wsolAta, authority.publicKey, authority.publicKey, [], TOKEN_PROGRAM_ID),
  );
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  console.log(`  ✓ ${label} — ${sig.slice(0, 20)}...`);
}

async function mintTokens(mint: PublicKey, amount: number, label: string) {
  const userAta = getAssociatedTokenAddressSync(mint, authority.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, userAta, authority.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint, userAta, authority.publicKey, amount, [], TOKEN_2022_PROGRAM_ID),
  );
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  console.log(`  Minted ${label}`);
}

async function main() {
  const addr = process.argv[2];
  if (!addr?.startsWith("pcoin:")) {
    console.error("Usage: bun run scripts/topup-all.ts pcoin:<stealth_address>");
    process.exit(1);
  }

  await initPoseidon();
  const meta = decodeStealthMetaAddress(addr);

  console.log(`=== Top-up All Tokens (${network}) ===`);
  console.log("Recipient:", addr.slice(0, 30) + "...");
  console.log("Program:", PRIVACY_COIN.toBase58());
  console.log("Authority:", authority.publicKey.toBase58());
  console.log();

  if (state.wsolMint) {
    console.log("─── wSOL ───");
    await shieldNativeSOL(meta, new PublicKey(state.wsolVault), 10_000_000n, "0.01 SOL");
  }

  if (state.tUsdcMint) {
    console.log("\n─── USDC ───");
    const mint = new PublicKey(state.tUsdcMint);
    await mintTokens(mint, 5_000_000_000, "5,000 USDC");
    await shieldToken2022(meta, mint, new PublicKey(state.tUsdcVault), 2_000_000_000n, "2,000 USDC");
  }

  if (state.tUsdtMint) {
    console.log("\n─── USDT ───");
    const mint = new PublicKey(state.tUsdtMint);
    await mintTokens(mint, 5_000_000_000, "5,000 USDT");
    await shieldToken2022(meta, mint, new PublicKey(state.tUsdtVault), 2_000_000_000n, "2,000 USDT");
  }

  if (state.jupUsdMint) {
    console.log("\n─── jupUSD ───");
    const mint = new PublicKey(state.jupUsdMint);
    await mintTokens(mint, 5_000_000_000, "5,000 jupUSD");
    await shieldToken2022(meta, mint, new PublicKey(state.jupUsdVault), 2_000_000_000n, "2,000 jupUSD");
  }

  console.log("\n=== ALL DONE ===");
}

main().catch(err => {
  console.error("Error:", err.message || err);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
