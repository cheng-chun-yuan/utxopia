#!/usr/bin/env bun
/**
 * Step 5: Shield SPL Tokens
 *
 * Shield real tokens into the privacy pool:
 *   - 1000 tUSDC (Token-2022 test mint)
 *   - 0.1 SOL → wSOL (NATIVE_MINT_2022) → shield
 */

import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT_2022,
} from "@solana/spl-token";
import * as crypto from "crypto";
// SDK Poseidon used instead of circomlibjs

import {
  connection,
  loadAuthority,
  loadState,
  updateState,
  trackCommitments,
  stepHeader,
  log,
  Disc,
  bigintToBytes32BE,
  bytes32ToBigintBE,
  sendIx,
  randomFieldElement,
  parseCommitmentTree,
  parseTokenConfig,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveTokenConfigPDA,
  deriveATA,
  TOKEN_2022,
  NoteState,
  initPoseidon,
  computeNPKSync,
  computeJoinSplitCommitmentSync,
} from "./shared.js";

stepHeader(5, "Shield SPL Tokens");

async function shieldToken(
  authority: ReturnType<typeof loadAuthority>,
  utxopia: PublicKey,
  poolState: PublicKey,
  commitmentTree: PublicKey,
  mint: PublicKey,
  vault: PublicKey,
  amount: bigint,
  _poseidonHash: unknown, // unused — SDK Poseidon used instead
  mpk: bigint,
  label: string,
): Promise<NoteState> {
  const [tokenConfig] = deriveTokenConfigPDA(utxopia, mint);
  const userAta = deriveATA(mint, authority.publicKey);

  // Generate note
  const random = randomFieldElement();
  const npk = computeNPKSync(mpk, random);
  const npkBytes = bigintToBytes32BE(npk);
  const ephPub = crypto.randomBytes(32);

  // Read token_id from on-chain TokenConfig
  const tcInfo = await connection.getAccountInfo(tokenConfig);
  const tc = parseTokenConfig(Buffer.from(tcInfo!.data))!;
  const tokenIdBigint = BigInt("0x" + Buffer.from(tc.tokenId).toString("hex"));

  // Compute shielded amount after deposit_fee_bps (0.2% = 20 bps)
  const DEPOSIT_FEE_BPS = 20n;
  const fee = amount * DEPOSIT_FEE_BPS / 10_000n;
  const shieldedAmount = amount - fee;

  const commitment = computeJoinSplitCommitmentSync(npk, tokenIdBigint, shieldedAmount);

  // Read tree
  const treeInfo = await connection.getAccountInfo(commitmentTree);
  const treeData = parseCommitmentTree(Buffer.from(treeInfo!.data));
  const leafIndex = Number(treeData!.nextIndex);

  // Build shield instruction (disc=29)
  const data = Buffer.alloc(1 + 72);
  data[0] = Disc.SHIELD;
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
    programId: utxopia,
    data,
  });

  const sig = await sendIx([ix], [authority]);
  log(`${label}: shielded ${amount} at leaf ${leafIndex} — ${sig.slice(0, 20)}...`);

  // Verify token config updated
  const tcAfter = await connection.getAccountInfo(tokenConfig);
  const tcDataAfter = parseTokenConfig(Buffer.from(tcAfter!.data))!;
  log(`${label}: total_shielded = ${tcDataAfter.totalShielded}`);

  return {
    npk: npk.toString(16),
    random: random.toString(16),
    amount: Number(shieldedAmount),
    leafIndex,
    commitment: commitment.toString(16),
    tokenId: tokenIdBigint.toString(16),
  };
}

/**
 * Shield SOL by wrapping to wSOL (NATIVE_MINT_2022) in a single transaction:
 *   1. Create wSOL ATA (idempotent)
 *   2. Transfer SOL → wSOL ATA
 *   3. syncNative
 *   4. Shield (disc=29)
 *   5. Close wSOL ATA (reclaim rent)
 */
async function shieldSOL(
  authority: ReturnType<typeof loadAuthority>,
  utxopia: PublicKey,
  poolState: PublicKey,
  commitmentTree: PublicKey,
  lamports: bigint,
  _poseidonHash: unknown, // unused — SDK Poseidon used instead
  mpk: bigint,
): Promise<NoteState> {
  const wsolMint = NATIVE_MINT_2022;
  const [tokenConfig] = deriveTokenConfigPDA(utxopia, wsolMint);

  // Check if wSOL TokenConfig exists
  const tcInfo = await connection.getAccountInfo(tokenConfig);
  if (!tcInfo) {
    throw new Error("wSOL TokenConfig not registered. Clone NATIVE_MINT_2022 from devnet and run register_token.");
  }
  const tc = parseTokenConfig(Buffer.from(tcInfo.data))!;
  const tokenIdBigint = BigInt("0x" + Buffer.from(tc.tokenId).toString("hex"));

  // Vault for wSOL (owned by pool state PDA)
  const vault = new PublicKey(tc.vault);

  // Compute shielded amount after deposit_fee_bps (0.2% = 20 bps)
  const DEPOSIT_FEE_BPS = 20n;
  const fee = lamports * DEPOSIT_FEE_BPS / 10_000n;
  const shieldedLamports = lamports - fee;

  // Generate note
  const random = randomFieldElement();
  const npk = computeNPKSync(mpk, random);
  const npkBytes = bigintToBytes32BE(npk);
  const ephPub = crypto.randomBytes(32);
  const commitment = computeJoinSplitCommitmentSync(npk, tokenIdBigint, shieldedLamports);

  // Read tree for leaf index
  const treeInfo = await connection.getAccountInfo(commitmentTree);
  const treeData = parseCommitmentTree(Buffer.from(treeInfo!.data));
  const leafIndex = Number(treeData!.nextIndex);

  // wSOL ATA for user
  const wsolAta = getAssociatedTokenAddressSync(
    wsolMint, authority.publicKey, false, TOKEN_2022_PROGRAM_ID,
  );

  // Build all instructions in one transaction
  const tx = new Transaction();

  // 1. Create wSOL ATA (idempotent)
  tx.add(createAssociatedTokenAccountIdempotentInstruction(
    authority.publicKey, wsolAta, authority.publicKey, wsolMint, TOKEN_2022_PROGRAM_ID,
  ));

  // 2. Transfer SOL → wSOL ATA
  tx.add(SystemProgram.transfer({
    fromPubkey: authority.publicKey,
    toPubkey: wsolAta,
    lamports: Number(lamports),
  }));

  // 3. Sync native balance
  tx.add(createSyncNativeInstruction(wsolAta, TOKEN_2022_PROGRAM_ID));

  // 4. Shield instruction (disc=29)
  const shieldData = Buffer.alloc(1 + 72);
  shieldData[0] = Disc.SHIELD;
  shieldData.writeBigUInt64LE(lamports, 1);
  Buffer.from(npkBytes).copy(shieldData, 9);
  Buffer.from(ephPub).copy(shieldData, 41);

  tx.add(new TransactionInstruction({
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: wsolAta, isSigner: false, isWritable: true },
      { pubkey: poolState, isSigner: false, isWritable: false },
      { pubkey: tokenConfig, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: utxopia,
    data: shieldData,
  }));

  // 5. Close wSOL ATA (reclaim rent back to user)
  tx.add(createCloseAccountInstruction(
    wsolAta, authority.publicKey, authority.publicKey, [], TOKEN_2022_PROGRAM_ID,
  ));

  // Send
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" });

  const solAmount = Number(lamports) / LAMPORTS_PER_SOL;
  log(`SOL→wSOL: wrapped ${solAmount} SOL + shielded at leaf ${leafIndex} — ${sig.slice(0, 20)}...`);

  // Verify
  const tcAfter = await connection.getAccountInfo(tokenConfig);
  const tcDataAfter = parseTokenConfig(Buffer.from(tcAfter!.data))!;
  log(`wSOL: total_shielded = ${tcDataAfter.totalShielded} lamports (${Number(tcDataAfter.totalShielded) / LAMPORTS_PER_SOL} SOL)`);

  return {
    npk: npk.toString(16),
    random: random.toString(16),
    amount: Number(shieldedLamports),
    leafIndex,
    commitment: commitment.toString(16),
    tokenId: tokenIdBigint.toString(16),
  };
}

async function main() {
  const state = loadState();
  const authority = loadAuthority();
  const UTXOPIA = new PublicKey(state.utxopiaProgramId);
  const [poolState] = derivePoolStatePDA(UTXOPIA);
  const [commitmentTree] = deriveCommitmentTreePDA(UTXOPIA);

  await initPoseidon();
  const poseidonHash = null; // passed to functions for backward compat, but SDK used internally
  const mpk = BigInt("0x" + state.mpk!);

  if (!state.tUsdcMint) {
    throw new Error("tUSDC mint not found in state. Run step2 first.");
  }

  // Shield 1000 tUSDC (6 decimals → 1_000_000_000)
  const usdcNote = await shieldToken(
    authority, UTXOPIA, poolState, commitmentTree,
    new PublicKey(state.tUsdcMint), new PublicKey(state.tUsdcVault!),
    1_000_000_000n, poseidonHash, mpk, "tUSDC",
  );

  // Shield 0.1 SOL → wSOL (NATIVE_MINT_2022) → shield
  // 0.1 SOL = 100_000_000 lamports
  let wsolNote: NoteState;
  try {
    wsolNote = await shieldSOL(
      authority, UTXOPIA, poolState, commitmentTree,
      100_000_000n, // 0.1 SOL
      poseidonHash, mpk,
    );
  } catch (err: any) {
    // wSOL might not be available on localnet without NATIVE_MINT_2022 clone
    if (err.message?.includes("TokenConfig not registered")) {
      log("wSOL: NATIVE_MINT_2022 not available — falling back to tWSOL");
      if (!state.tWsolMint) throw new Error("Neither wSOL nor tWSOL available");
      wsolNote = await shieldToken(
        authority, UTXOPIA, poolState, commitmentTree,
        new PublicKey(state.tWsolMint), new PublicKey(state.tWsolVault!),
        5_000_000_000n, poseidonHash, mpk, "tWSOL (fallback)",
      );
    } else {
      throw err;
    }
  }

  updateState({ usdcNote, wsolNote });
  trackCommitments(usdcNote.commitment, wsolNote.commitment);

  console.log("\nStep 5: Shield SPL Tokens ....... PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
