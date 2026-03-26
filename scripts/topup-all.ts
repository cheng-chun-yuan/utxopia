#!/usr/bin/env bun
/**
 * Top up a stealth address with all registered tokens.
 *
 * Usage:
 *   AEGIS_NETWORK=devnet bun run scripts/topup-all.ts aegis:<address>
 *   bun run scripts/topup-all.ts aegis:<address>   # defaults to localnet
 */

import {
  initPoseidon,
  createStealthDepositWithKeys,
  decodeStealthMetaAddress,
  computeTokenId,
  buildShieldInstructionData,
} from "@aegis/sdk";
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

const network = (process.env.AEGIS_NETWORK || "localnet") as "localnet" | "devnet";
const { conn, authority, programId: AEGIS, state } = setupScript(network);

function pda(seeds: (string | Uint8Array)[]) {
  return PublicKey.findProgramAddressSync(
    seeds.map(s => typeof s === "string" ? Buffer.from(s) : s), AEGIS
  );
}

async function readTokenId(mint: PublicKey): Promise<bigint> {
  return computeTokenId(mint.toBytes());
}

/**
 * Build shield instruction keys (same for Token and Token-2022).
 */
function shieldKeys(
  userAta: PublicKey, vault: PublicKey, tokenConfig: PublicKey, tokenProgram: PublicKey,
) {
  const [poolState] = pda(["pool_state"]);
  const [commitmentTree] = pda(["commitment_tree"]);
  return [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: userAta, isSigner: false, isWritable: true },
    { pubkey: poolState, isSigner: false, isWritable: false },
    { pubkey: tokenConfig, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: commitmentTree, isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ];
}

/**
 * Build shield instruction data using SDK.
 */
function buildShieldData(stealth: { stealthPubKeyX: bigint; ephemeralPub: Uint8Array }, amount: bigint): Buffer {
  const npkBytes = Buffer.alloc(32);
  let npk = stealth.stealthPubKeyX;
  for (let i = 31; i >= 0; i--) { npkBytes[i] = Number(npk & 0xffn); npk >>= 8n; }

  const data = buildShieldInstructionData({
    amount,
    npk: npkBytes,
    ephemeralPub: stealth.ephemeralPub,
  });
  return Buffer.from(data);
}

/**
 * Shield Token-2022 SPL tokens to a stealth address.
 */
async function shieldToken2022(
  meta: ReturnType<typeof decodeStealthMetaAddress>,
  tokenId: bigint, mint: PublicKey, vault: PublicKey,
  amount: bigint, label: string,
) {
  const stealth = await createStealthDepositWithKeys(meta, amount, tokenId);
  const [tokenConfig] = pda(["token_config", mint.toBuffer()]);
  const userAta = getAssociatedTokenAddressSync(mint, authority.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const ix = new TransactionInstruction({
    keys: shieldKeys(userAta, vault, tokenConfig, TOKEN_2022_PROGRAM_ID),
    programId: AEGIS,
    data: buildShieldData(stealth, amount),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  console.log(`  ✓ ${label} — ${sig.slice(0, 20)}...`);
}

/**
 * Shield native wSOL (legacy Token program) to a stealth address.
 * Wraps SOL → wSOL → shield → close wSOL account.
 */
async function shieldNativeSOL(
  meta: ReturnType<typeof decodeStealthMetaAddress>,
  tokenId: bigint, vault: PublicKey,
  amount: bigint, label: string,
) {
  const stealth = await createStealthDepositWithKeys(meta, amount, tokenId);
  const [tokenConfig] = pda(["token_config", NATIVE_MINT.toBuffer()]);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, authority.publicKey, false, TOKEN_PROGRAM_ID);

  const tx = new Transaction();

  // 1. Create wSOL ATA
  tx.add(createAssociatedTokenAccountIdempotentInstruction(
    authority.publicKey, wsolAta, authority.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID,
  ));

  // 2. Transfer SOL → wSOL
  tx.add(SystemProgram.transfer({
    fromPubkey: authority.publicKey,
    toPubkey: wsolAta,
    lamports: Number(amount),
  }));

  // 3. Sync native
  tx.add(createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID));

  // 4. Shield instruction (same disc=12, just legacy Token program)
  tx.add(new TransactionInstruction({
    keys: shieldKeys(wsolAta, vault, tokenConfig, TOKEN_PROGRAM_ID),
    programId: AEGIS,
    data: buildShieldData(stealth, amount),
  }));

  // 5. Close wSOL account
  tx.add(createCloseAccountInstruction(wsolAta, authority.publicKey, authority.publicKey, [], TOKEN_PROGRAM_ID));

  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  console.log(`  ✓ ${label} — ${sig.slice(0, 20)}...`);
}

/**
 * Mint Token-2022 test tokens to authority's ATA.
 */
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
  const addr = process.argv[2] || "aegis:c4b3323759ae3e33d82ce13f9e6454ab01400f509f3092deb7d1b31b60c37d14552ab7a1ce6a4fca70783bd40b3c03e8a24c50b65a3fb9edc6e0c70ee389f2af20c7827efc517ed74a46be26953f715ae945d9d49ee9bcd275ab1ea217cfe708";

  await initPoseidon();
  const meta = decodeStealthMetaAddress(addr);

  console.log(`=== Top-up All Tokens (${network}) ===`);
  console.log("Recipient:", addr.slice(0, 30) + "...");
  console.log("Program:", AEGIS.toBase58());
  console.log("Authority:", authority.publicKey.toBase58());
  console.log();

  // 1. wSOL (native — wrap SOL and shield)
  if (state.wsolMint) {
    console.log("─── wSOL (native wrap) ───");
    const wsolVault = new PublicKey(state.wsolVault);
    const wsolTokenId = await readTokenId(NATIVE_MINT);
    await shieldNativeSOL(meta, wsolTokenId, wsolVault, 10_000_000n, "0.01 SOL");
  }

  // 2. USDC
  if (state.tUsdcMint) {
    console.log("\n─── USDC ───");
    const usdcMint = new PublicKey(state.tUsdcMint);
    const usdcVault = new PublicKey(state.tUsdcVault);
    const usdcTokenId = await readTokenId(usdcMint);
    await mintTokens(usdcMint, 5_000_000_000, "5,000 USDC");
    await shieldToken2022(meta, usdcTokenId, usdcMint, usdcVault, 2_000_000_000n, "2,000 USDC");
  }

  // 3. USDT
  if (state.tUsdtMint) {
    console.log("\n─── USDT ───");
    const usdtMint = new PublicKey(state.tUsdtMint);
    const usdtVault = new PublicKey(state.tUsdtVault);
    const usdtTokenId = await readTokenId(usdtMint);
    await mintTokens(usdtMint, 5_000_000_000, "5,000 USDT");
    await shieldToken2022(meta, usdtTokenId, usdtMint, usdtVault, 2_000_000_000n, "2,000 USDT");
  }

  // 4. jupUSD
  if (state.jupUsdMint) {
    console.log("\n─── jupUSD ───");
    const jupMint = new PublicKey(state.jupUsdMint);
    const jupVault = new PublicKey(state.jupUsdVault);
    const jupTokenId = await readTokenId(jupMint);
    await mintTokens(jupMint, 5_000_000_000, "5,000 jupUSD");
    await shieldToken2022(meta, jupTokenId, jupMint, jupVault, 2_000_000_000n, "2,000 jupUSD");
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
