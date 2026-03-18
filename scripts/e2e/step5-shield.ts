#!/usr/bin/env bun
/**
 * Step 5: Shield SPL Tokens
 *
 * Shield 1000 tUSDC and 5 tWSOL into the privacy pool (disc=29).
 */

import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as crypto from "crypto";
import { buildPoseidon } from "circomlibjs";

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
} from "./shared.js";

stepHeader(5, "Shield SPL Tokens");

async function shieldToken(
  authority: ReturnType<typeof loadAuthority>,
  aegis: PublicKey,
  poolState: PublicKey,
  commitmentTree: PublicKey,
  mint: PublicKey,
  vault: PublicKey,
  amount: bigint,
  poseidonHash: (inputs: bigint[]) => bigint,
  mpk: bigint,
  label: string,
): Promise<NoteState> {
  const [tokenConfig] = deriveTokenConfigPDA(aegis, mint);
  const userAta = deriveATA(mint, authority.publicKey);

  // Generate note
  const random = randomFieldElement();
  const npk = poseidonHash([mpk, random]);
  const npkBytes = bigintToBytes32BE(npk);
  const ephPub = crypto.randomBytes(32);

  // Read token_id from on-chain TokenConfig
  const tcInfo = await connection.getAccountInfo(tokenConfig);
  const tc = parseTokenConfig(Buffer.from(tcInfo!.data))!;
  const tokenIdBigint = BigInt("0x" + Buffer.from(tc.tokenId).toString("hex"));
  const commitment = poseidonHash([npk, tokenIdBigint, amount]);

  // Read tree
  const treeInfo = await connection.getAccountInfo(commitmentTree);
  const treeData = parseCommitmentTree(Buffer.from(treeInfo!.data));
  const leafIndex = Number(treeData!.nextIndex);

  // Build shield instruction (disc=29)
  // Data: amount(8) + npk(32) + ephemeral_pub(32) = 72 bytes
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
    programId: aegis,
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
    amount: Number(amount),
    leafIndex,
    commitment: commitment.toString(16),
    tokenId: tokenIdBigint.toString(16),
  };
}

async function main() {
  const state = loadState();
  const authority = loadAuthority();
  const AEGIS = new PublicKey(state.aegisProgramId);
  const [poolState] = derivePoolStatePDA(AEGIS);
  const [commitmentTree] = deriveCommitmentTreePDA(AEGIS);

  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const poseidonHash = (inputs: bigint[]) => F.toObject(poseidon(inputs)) as bigint;
  const mpk = BigInt("0x" + state.mpk!);

  if (!state.tUsdcMint || !state.tWsolMint) {
    throw new Error("Token mints not found in state. Run step2 first.");
  }

  // Shield 1000 tUSDC (6 decimals → 1_000_000_000)
  const usdcNote = await shieldToken(
    authority, AEGIS, poolState, commitmentTree,
    new PublicKey(state.tUsdcMint), new PublicKey(state.tUsdcVault!),
    1_000_000_000n, poseidonHash, mpk, "tUSDC",
  );

  // Shield 5 tWSOL (9 decimals → 5_000_000_000)
  const wsolNote = await shieldToken(
    authority, AEGIS, poolState, commitmentTree,
    new PublicKey(state.tWsolMint), new PublicKey(state.tWsolVault!),
    5_000_000_000n, poseidonHash, mpk, "tWSOL",
  );

  updateState({ usdcNote, wsolNote });
  trackCommitments(usdcNote.commitment, wsolNote.commitment);

  console.log("\nStep 5: Shield SPL Tokens ....... PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
