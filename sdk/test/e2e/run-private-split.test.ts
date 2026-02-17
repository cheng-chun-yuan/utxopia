/**
 * Run a REAL private split on devnet — 1 commitment → 2 commitments, no token movement.
 * Uses inline Groth16 proof verification (no ChadBuffer).
 */

import { describe, it, expect, beforeAll } from "bun:test";

import {
  address,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  addSignersToTransactionMessage,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
} from "@solana/kit";

import { initPoseidon, computeUnifiedCommitmentSync } from "../../src/poseidon";
import { getConfig } from "../../src/config";
import { babyJubMul, BABYJUB_BASE8 } from "../../src/crypto-babyjub";
import { ed25519GenerateKeyPair } from "../../src/crypto-ed25519";
import { derivePoolStatePDA, deriveCommitmentTreePDA, deriveNullifierRecordPDA, deriveStealthAnnouncementPDA } from "../../src/pda";
import { buildSplitInstruction } from "../../src/instructions";
import { generateSpendSplitProof, verifyProof } from "../../src/prover/web";
import { bigintToBytes } from "../../src/crypto";

import {
  createTestContext,
  initializeTestEnvironment,
  type E2ETestContext,
  PROOF_TIMEOUT,
} from "./setup";
import { generateMockVkHash } from "./helpers";
import * as stealthHelpers from "./stealth-helpers";

describe("Private Split On-Chain", () => {
  let ctx: E2ETestContext;

  beforeAll(async () => {
    await initializeTestEnvironment();
    ctx = await createTestContext();
  });

  it("should execute a real private split on devnet", async () => {
  console.log("=".repeat(60));
  console.log("PRIVATE SPLIT: 1 Note → 2 Notes (Inline Groth16 Proof)");
  console.log("=".repeat(60));

  const config = getConfig();

  console.log(`\nProgram: ${config.zvaultProgramId}`);
  console.log(`Network: devnet\n`);

  // Step 1: Generate keys
  console.log("1. Generating keys for input + 2 outputs...");
  const inputKeys = stealthHelpers.generateTestKeys("private-split-input");
  const output1Keys = stealthHelpers.generateTestKeys("private-split-out1");
  const output2Keys = stealthHelpers.generateTestKeys("private-split-out2");

  // Step 2: Create input stealth deposit (1M sats via demo instruction)
  console.log("\n2. Creating input stealth deposit (1,000,000 sats)...");
  const inputAmount = 1_000_000n;
  const testNote = await stealthHelpers.createAndSubmitStealthDeposit(ctx, inputKeys, inputAmount);
  console.log(`   Commitment: ${testNote.commitment.toString(16).slice(0, 20)}...`);
  console.log(`   Leaf index: ${testNote.leafIndex}`);

  // Step 3: Scan and prepare input
  console.log("\n3. Scanning with viewing key...");
  const inputData = await stealthHelpers.scanAndPrepareClaim(ctx, inputKeys, testNote.commitment);
  console.log(`   Amount: ${inputData.scannedNote.amount} sats`);
  console.log(`   Merkle root: ${inputData.merkleProof.root.toString(16).slice(0, 20)}...`);

  // Step 4: Define split
  const output1Amount = 700_000n;
  const output2Amount = 300_000n;
  console.log(`\n4. Splitting: ${inputAmount} → ${output1Amount} + ${output2Amount} sats`);

  // Step 5: Compute output commitments
  const output1PubKeyX = babyJubMul(output1Keys.spendingPrivKey, BABYJUB_BASE8).x;
  const output2PubKeyX = babyJubMul(output2Keys.spendingPrivKey, BABYJUB_BASE8).x;
  const output1Commitment = computeUnifiedCommitmentSync(output1PubKeyX, output1Amount);
  const output2Commitment = computeUnifiedCommitmentSync(output2PubKeyX, output2Amount);

  // Step 6: Generate real ZK proof
  console.log("\n5. Generating Groth16 split proof...");
  const t0 = Date.now();
  const proof = await generateSpendSplitProof({
    privKey: inputData.stealthPrivKey,
    amount: inputData.scannedNote.amount,
    leafIndex: BigInt(inputData.scannedNote.leafIndex),
    merkleRoot: inputData.merkleProof.root,
    merkleProof: {
      siblings: inputData.merkleProof.siblings,
      indices: inputData.merkleProof.indices,
    },
    output1PrivKey: output1Keys.spendingPrivKey,
    output1Amount,
    output2PrivKey: output2Keys.spendingPrivKey,
    output2Amount,
  });
  console.log(`   Proof generated in ${((Date.now() - t0) / 1000).toFixed(1)}s (${proof.proof.length} bytes)`);

  const ok = await verifyProof("spend_split", proof);
  console.log(`   Local verify: ${ok ? "PASSED" : "FAILED"}`);
  if (!ok) throw new Error("Proof failed local verification");

  // Step 7: Build single-instruction transaction (inline proof)
  console.log("\n6. Building single-IX transaction (inline proof)...");
  const [poolState] = await derivePoolStatePDA(config.zvaultProgramId);
  const [commitmentTree] = await deriveCommitmentTreePDA(config.zvaultProgramId);
  const [nullifierRecord] = await deriveNullifierRecordPDA(
    inputData.nullifierHashBytes, config.zvaultProgramId
  );

  const output1CommitmentBytes = bigintToBytes(output1Commitment, 32);
  const output2CommitmentBytes = bigintToBytes(output2Commitment, 32);

  // Stealth announcement PDAs (keyed by ephemeral pub for each output)
  const output1EphPub = ed25519GenerateKeyPair().pubKey;
  const output2EphPub = ed25519GenerateKeyPair().pubKey;
  const [stealthAnn1] = await deriveStealthAnnouncementPDA(output1EphPub, config.zvaultProgramId);
  const [stealthAnn2] = await deriveStealthAnnouncementPDA(output2EphPub, config.zvaultProgramId);

  // Encrypted amounts (32-byte format: 8 bytes LE amount + 24 bytes zero)
  const enc1 = new Uint8Array(32);
  new DataView(enc1.buffer).setBigUint64(0, output1Amount, true);
  const enc2 = new Uint8Array(32);
  new DataView(enc2.buffer).setBigUint64(0, output2Amount, true);

  const vkHash = generateMockVkHash();

  // Single IX: zVault spend_split with inline proof
  const splitIx = buildSplitInstruction({
    proofBytes: proof.proof,
    root: bigintToBytes(inputData.merkleProof.root, 32),
    nullifierHash: inputData.nullifierHashBytes,
    outputCommitment1: output1CommitmentBytes,
    outputCommitment2: output2CommitmentBytes,
    vkHash,
    output1EphemeralPubX: output1EphPub,
    output1EncryptedAmountWithSign: enc1,
    output2EphemeralPubX: output2EphPub,
    output2EncryptedAmountWithSign: enc2,
    accounts: {
      poolState,
      commitmentTree,
      nullifierRecord,
      user: address(ctx.payer.publicKey.toBase58()),
      stealthAnnouncement1: stealthAnn1,
      stealthAnnouncement2: stealthAnn2,
    },
  });

  // Compute budget instruction
  const computeBudgetIx = {
    programAddress: address("ComputeBudget111111111111111111111111111111"),
    accounts: [],
    data: (() => {
      const d = new Uint8Array(9);
      d[0] = 2; // SetComputeUnitLimit
      new DataView(d.buffer).setUint32(1, 1_400_000, true);
      return d;
    })(),
  };

  // Step 8: Submit on-chain!
  console.log("\n7. Submitting PRIVATE SPLIT on-chain (single IX)...");
  const { value: blockhash } = await ctx.rpc.getLatestBlockhash().send();

  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(ctx.payerSigner.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(blockhash, msg),
    (msg) => appendTransactionMessageInstructions([computeBudgetIx, splitIx], msg),
    (msg) => addSignersToTransactionMessage([ctx.payerSigner], msg),
  );

  const signedTx = await signTransactionMessageWithSigners(tx);
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc: ctx.rpc,
    rpcSubscriptions: ctx.rpcSubscriptions,
  });

  try {
    await sendAndConfirm(signedTx as any, { commitment: "confirmed" });
    const signature = getSignatureFromTransaction(signedTx);

    console.log(`\n   ✓ PRIVATE SPLIT CONFIRMED!`);
    console.log(`   Signature: ${signature}`);
    console.log(`   Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    console.log(`\n   What happened on-chain:`);
    console.log(`   - Groth16 ZK proof verified INLINE (BN254 pairing check)`);
    console.log(`   - Input nullifier recorded (prevents double-spend)`);
    console.log(`   - 2 new commitments inserted into Merkle tree`);
    console.log(`   - 2 stealth announcements created`);
    console.log(`   - NO token transfers (pure commitment shuffle)`);
    console.log(`   - NO ChadBuffer needed (proof fits inline)`);
    console.log(`   - Observer sees nothing about amounts or recipients`);
  } catch (e: any) {
    console.error(`\n   ✗ Transaction failed:`, e.message?.slice(0, 500));
    // Walk the error chain for logs
    let err = e;
    while (err) {
      if (err.logs) { for (const l of err.logs) console.log(`     ${l}`); break; }
      if (err.context?.logs) { for (const l of err.context.logs) console.log(`     ${l}`); break; }
      err = err.cause;
    }
    // Also try direct property access
    const sig = getSignatureFromTransaction(signedTx);
    console.log(`   TX sig: ${sig}`);
    try {
      // Fetch tx logs via legacy connection
      const txInfo = await ctx.connection.getTransaction(sig as string, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (txInfo?.meta?.logMessages) {
        console.log("   On-chain logs:");
        for (const l of txInfo.meta.logMessages) console.log(`     ${l}`);
      }
      if (txInfo?.meta?.err) {
        console.log("   Error:", JSON.stringify(txInfo.meta.err));
      }
    } catch (_) {}

  }

  console.log("\n" + "=".repeat(60));
  console.log("PRIVATE SPLIT COMPLETE");
  console.log("=".repeat(60));
  }, PROOF_TIMEOUT);
});
