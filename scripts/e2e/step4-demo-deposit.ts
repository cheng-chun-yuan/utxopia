#!/usr/bin/env bun
/**
 * Step 4: Demo Deposit
 *
 * Add demo stealth deposit via add_demo_stealth (disc=13, 8 accounts).
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
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
  initPoseidon,
  computeNPKSync,
  computeJoinSplitCommitmentSync,
} from "./shared.js";

stepHeader(4, "Demo Deposit");

async function main() {
  const state = loadState();
  const authority = loadAuthority();
  const AEGIS = new PublicKey(state.aegisProgramId);
  const zkbtcMint = new PublicKey(state.zkbtcMint);
  const poolVault = new PublicKey(state.poolVault);
  const [poolState] = derivePoolStatePDA(AEGIS);
  const [commitmentTree] = deriveCommitmentTreePDA(AEGIS);
  const [zkbtcTokenConfig] = deriveTokenConfigPDA(AEGIS, zkbtcMint);

  // Initialize SDK Poseidon
  await initPoseidon();

  // Read actual token_id from on-chain TokenConfig
  const tcInfo = await connection.getAccountInfo(zkbtcTokenConfig);
  const tc = parseTokenConfig(Buffer.from(tcInfo!.data))!;
  const tokenId = BigInt("0x" + Buffer.from(tc.tokenId).toString("hex"));
  log(`zkBTC token_id: ${tokenId.toString(16).slice(0, 16)}...`);

  // Load keys from state
  const mpk = BigInt("0x" + state.mpk!);
  const amount = 30_000n; // enough for transfer (15k+15k) and withdrawal (>10k MIN_WITHDRAWAL_SATS)

  // Generate note
  const random = randomFieldElement();
  const npk = computeNPKSync(mpk, random);
  const npkBytes = bigintToBytes32BE(npk);
  const commitment = computeJoinSplitCommitmentSync(npk, tokenId, amount);
  const ephPub = crypto.randomBytes(32);

  // Read tree
  const treeInfo = await connection.getAccountInfo(commitmentTree);
  const treeData = parseCommitmentTree(Buffer.from(treeInfo!.data));
  const leafIndex = Number(treeData!.nextIndex);
  log(`Tree next_index: ${leafIndex}`);

  // Build add_demo_stealth (disc=13)
  // Data: ephemeral_pub(32) + npk(32) + amount_sats(8) = 72 bytes
  const data = Buffer.alloc(1 + 72);
  data[0] = Disc.ADD_DEMO_STEALTH;
  ephPub.copy(data, 1);
  Buffer.from(npkBytes).copy(data, 33);
  data.writeBigUInt64LE(amount, 65);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: zkbtcMint, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: zkbtcTokenConfig, isSigner: false, isWritable: false },
    ],
    programId: AEGIS,
    data,
  });

  const sig = await sendIx([ix], [authority]);
  log(`Demo deposit tx: ${sig.slice(0, 20)}...`);

  // Verify tree updated
  const treeAfter = await connection.getAccountInfo(commitmentTree);
  const treeDataAfter = parseCommitmentTree(Buffer.from(treeAfter!.data));
  if (Number(treeDataAfter!.nextIndex) !== leafIndex + 1) {
    throw new Error(`next_index expected ${leafIndex + 1}, got ${treeDataAfter!.nextIndex}`);
  }

  log(`Demo commitment at leaf ${leafIndex}: ${commitment.toString(16).slice(0, 16)}...`);

  // Save note with locally computed commitment
  // (frontier[0] only holds the correct value for even-indexed leaves)
  updateState({
    demoNote: {
      npk: npk.toString(16),
      random: random.toString(16),
      amount: Number(amount),
      leafIndex,
      commitment: commitment.toString(16),
      tokenId: tokenId.toString(16),
    },
  });
  trackCommitments(commitment.toString(16));

  // =========================================================================
  // Second deposit: external receiver (stealth meta-address)
  // =========================================================================
  const RECEIVER2_META = "aegis:9d2cb3fea6912aeb783760f47367c53f2fb2ed7240c98a99786172982950fe988f45b56ecd1d6d02f5007accc9fa430bc4dc91f1fabe1d37977cb773468ef3451b592c4e3881b34572c0d83baacfda725f04ac6810dbaf7227e7f69f784c1eb6";

  log("\nDepositing to external receiver...");
  const metaHex = RECEIVER2_META.slice(6); // strip "aegis:"
  const metaBytes = Buffer.from(metaHex, "hex");
  // Format: spendingPubKey(32) + viewingPubKey(32) + mpk(32)
  const receiver2Mpk = BigInt("0x" + metaBytes.subarray(64, 96).toString("hex"));
  log(`Receiver2 MPK: ${receiver2Mpk.toString(16).slice(0, 16)}...`);

  const amount2 = 20_000n;
  const random2 = randomFieldElement();
  const npk2 = computeNPKSync(receiver2Mpk, random2);
  const npk2Bytes = bigintToBytes32BE(npk2);
  const commitment2 = computeJoinSplitCommitmentSync(npk2, tokenId, amount2);
  const ephPub2 = crypto.randomBytes(32);

  // Read tree for next index
  const treeInfo2 = await connection.getAccountInfo(commitmentTree);
  const treeData2 = parseCommitmentTree(Buffer.from(treeInfo2!.data));
  const leafIndex2 = Number(treeData2!.nextIndex);

  // Build add_demo_stealth for receiver2
  const data2 = Buffer.alloc(1 + 72);
  data2[0] = Disc.ADD_DEMO_STEALTH;
  ephPub2.copy(data2, 1);
  Buffer.from(npk2Bytes).copy(data2, 33);
  data2.writeBigUInt64LE(amount2, 65);

  const ix2 = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: zkbtcMint, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: zkbtcTokenConfig, isSigner: false, isWritable: false },
    ],
    programId: AEGIS,
    data: data2,
  });

  const sig2 = await sendIx([ix2], [authority]);
  log(`Receiver2 deposit tx: ${sig2.slice(0, 20)}...`);
  log(`Receiver2 commitment at leaf ${leafIndex2}: ${commitment2.toString(16).slice(0, 16)}...`);
  trackCommitments(commitment2.toString(16));

  console.log("\nStep 4: Demo Deposit ............ PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
