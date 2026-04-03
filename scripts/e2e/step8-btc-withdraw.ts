#!/usr/bin/env bun
/**
 * Step 8: BTC Withdrawal Request
 *
 * Request redemption of the change note from Step 6 (4,000 sats).
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import * as crypto from "crypto";

import {
  connection,
  loadAuthority,
  loadState,
  stepHeader,
  log,
  Disc,
  bigintToBytes32BE,
  bytes32ToBigintBE,
  sendIx,
  parseCommitmentTree,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierPDA,
  deriveRedemptionPDA,
  deriveTokenConfigPDA,
  parsePoolState,
  initPoseidon,
  computeJoinSplitNullifierSync,
} from "./shared.js";

stepHeader(8, "BTC Withdrawal Request");

async function main() {
  const state = loadState();
  const authority = loadAuthority();
  const PRIVACY_COIN = new PublicKey(state.privacyCoinProgramId);
  const zkbtcMint = new PublicKey(state.zkbtcMint);
  const [poolState] = derivePoolStatePDA(PRIVACY_COIN);
  const [commitmentTree] = deriveCommitmentTreePDA(PRIVACY_COIN);
  const [zkbtcTokenConfig] = deriveTokenConfigPDA(PRIVACY_COIN, zkbtcMint);

  if (!state.transferNotes) throw new Error("Transfer notes not found. Run step6 first.");

  // Init SDK Poseidon
  await initPoseidon();

  const nullifyingKey = BigInt("0x" + state.nullifyingKey!);

  // Use the transfer send note (15k sats, above MIN_WITHDRAWAL_SATS=10k)
  const note = state.transferNotes.send;
  const amount = BigInt(note.amount);
  const leafIndex = note.leafIndex;
  log(`Redeeming: leaf ${leafIndex}, ${amount} sats`);

  // Read pool state before
  const poolInfo = await connection.getAccountInfo(poolState);
  const poolBefore = parsePoolState(Buffer.from(poolInfo!.data))!;
  log(`Pool before: shielded=${poolBefore.totalShielded}, pending=${poolBefore.pendingRedemptions}`);

  // Compute nullifier using SDK
  const nullifier = computeJoinSplitNullifierSync(nullifyingKey, BigInt(leafIndex));
  const nullifierBytes = bigintToBytes32BE(nullifier);
  log(`Nullifier: ${nullifier.toString(16).slice(0, 16)}...`);

  // Read merkle root
  const treeInfo = await connection.getAccountInfo(commitmentTree);
  const treeData = parseCommitmentTree(Buffer.from(treeInfo!.data))!;
  const merkleRoot = new Uint8Array(treeData.currentRoot);

  // Build request_redemption (disc=5)
  // Data: proof_hash(32) + merkle_root(32) + nullifier_hash(32) + amount_sats(8) + vk_hash(32)
  //       + btc_script_len(1) + btc_script(var) + request_nonce(8)
  const proofHash = new Uint8Array(32); // zeros (demo mode)
  const vkHash = new Uint8Array(32);    // zeros (demo mode)

  // BTC withdrawal address: generate a real regtest P2WPKH address
  const { getNewAddress, bitcoinCli } = await import("../../contracts/scripts/regtest-helpers.js");
  const withdrawAddr = getNewAddress("bech32");
  const addrInfo = JSON.parse(bitcoinCli(`getaddressinfo ${withdrawAddr}`));
  const btcScript = Buffer.from(addrInfo.scriptPubKey, "hex");
  log(`Withdraw to: ${withdrawAddr}`);
  const requestNonce = 1n;

  const dataLen = 1 + 32 + 32 + 32 + 8 + 32 + 1 + btcScript.length + 8;
  const data = Buffer.alloc(dataLen);
  let off = 0;
  data[off++] = Disc.REQUEST_REDEMPTION;
  Buffer.from(proofHash).copy(data, off); off += 32;
  Buffer.from(merkleRoot).copy(data, off); off += 32;
  Buffer.from(nullifierBytes).copy(data, off); off += 32;
  data.writeBigUInt64LE(amount, off); off += 8;
  Buffer.from(vkHash).copy(data, off); off += 32;
  data[off++] = btcScript.length;
  btcScript.copy(data, off); off += btcScript.length;
  data.writeBigUInt64LE(requestNonce, off); off += 8;

  // Accounts (7): poolState, commitmentTree, nullifier, redemption, user, system, tokenConfig
  const [nullifierPDA] = deriveNullifierPDA(PRIVACY_COIN, nullifierBytes);
  const [redemptionPDA] = deriveRedemptionPDA(PRIVACY_COIN, authority.publicKey, requestNonce);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: false },
      { pubkey: nullifierPDA, isSigner: false, isWritable: true },
      { pubkey: redemptionPDA, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: zkbtcTokenConfig, isSigner: false, isWritable: true },
    ],
    programId: PRIVACY_COIN,
    data,
  });

  const sig = await sendIx([ix], [authority]);
  log(`Redemption tx: ${sig.slice(0, 20)}...`);

  // Verify redemption PDA
  const redemptionInfo = await connection.getAccountInfo(redemptionPDA);
  if (!redemptionInfo || redemptionInfo.data[0] !== 0x04) {
    throw new Error("Redemption PDA not created");
  }
  log("Redemption PDA created (status=Pending)");

  // Verify nullifier
  const nullifierInfo = await connection.getAccountInfo(nullifierPDA);
  if (!nullifierInfo || nullifierInfo.data[0] !== 0x03) {
    throw new Error("Nullifier PDA not created");
  }
  log("Nullifier PDA created");

  // Verify pool state
  const poolInfoAfter = await connection.getAccountInfo(poolState);
  const poolAfter = parsePoolState(Buffer.from(poolInfoAfter!.data))!;
  log(`Pool after: shielded=${poolAfter.totalShielded}, pending=${poolAfter.pendingRedemptions}`);

  console.log("\nStep 8: BTC Withdrawal Request .. PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
