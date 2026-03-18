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
import { buildPoseidon } from "circomlibjs";

import {
  connection,
  loadAuthority,
  loadState,
  updateState,
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

  // Initialize Poseidon
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const poseidonHash = (inputs: bigint[]) => F.toObject(poseidon(inputs)) as bigint;

  // Read actual token_id from on-chain TokenConfig
  const tcInfo = await connection.getAccountInfo(zkbtcTokenConfig);
  const tc = parseTokenConfig(Buffer.from(tcInfo!.data))!;
  const tokenId = BigInt("0x" + Buffer.from(tc.tokenId).toString("hex"));
  log(`zkBTC token_id: ${tokenId.toString(16).slice(0, 16)}...`);

  // Load keys from state
  const mpk = BigInt("0x" + state.mpk!);
  const amount = 10_000n;

  // Generate note
  const random = randomFieldElement();
  const npk = poseidonHash([mpk, random]);
  const npkBytes = bigintToBytes32BE(npk);
  const commitment = poseidonHash([npk, tokenId, amount]);
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

  console.log("\nStep 4: Demo Deposit ............ PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
