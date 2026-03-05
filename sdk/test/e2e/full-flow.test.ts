/**
 * Full E2E Flow Test: Groth16 Verification — Claim + Spend Partial Public
 *
 * ⚠️  DEPRECATED: This test uses legacy claim/spend_partial_public circuits.
 * The current Aegis implementation uses JoinSplit circuits instead.
 *
 * For current E2E tests, use:
 * - scripts/e2e-mock-spv.ts - Mock SPV deposit flow
 * - scripts/e2e-full-spv-flow.ts - Full SPV + JoinSplit flow
 * - scripts/e2e-instructions.ts - Individual instruction tests
 *
 * This file is kept for reference only and tests will be skipped.
 *
 * Tests the complete flow with real Groth16 proofs on localnet:
 * 1. Deposit → Merkle tree → Generate proof → Verify on-chain → Claim
 * 2. Deposit → Spend Partial Public with change commitment
 * 3. Chained flow: Deposit → Claim → Verify balance
 *
 * Prerequisites:
 * - solana-test-validator running with BN254 support:
 *   solana-test-validator --clone-feature-set --url devnet --reset
 * - Programs deployed:
 *   cd contracts && cargo build-sbf --features devnet && bun run deploy:localnet
 * - Circuits compiled:
 *   cd circuits && bash scripts/compile.sh && bash scripts/setup.sh
 *
 * Run: NETWORK=localnet bun test test/e2e/full-flow.test.ts
 */

import { describe, test, expect, beforeAll, setDefaultTimeout } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import {
  address,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  addSignersToTransactionMessage,
  type Instruction,
} from "@solana/kit";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

import {
  createTestContext,
  initializeTestEnvironment,
  logTestEnvironment,
  type E2ETestContext,
} from "./setup";

// NOTE: Imports removed — this test file is DEPRECATED and all tests are describe.skip'd.
// Legacy imports referenced removed modules (stealth-helpers, buildSpendPartialPublicInstruction).
// For current tests, see: scripts/e2e-mock-spv.ts, scripts/e2e-full-spv-flow.ts

import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

// Proof generation can take ~60s
setDefaultTimeout(300_000);

const CIRCUIT_BUILD_PATH = path.resolve(__dirname, "../../../circuits/build");
const SDK_DIR = path.resolve(__dirname, "../..");

// =============================================================================
// Proof Generation Helpers (Node.js subprocess for bun compatibility)
// =============================================================================

/**
 * Generate a Groth16 proof via Node.js subprocess
 * (bun has issues with snarkjs WASM, so we use node)
 */
function generateProofViaNode(
  circuitName: string,
  inputs: Record<string, string | string[] | number[]>
): { proof: any; publicSignals: string[]; proofBytes: Uint8Array } {
  const wasmPath = path.join(CIRCUIT_BUILD_PATH, `${circuitName}/${circuitName}_js/${circuitName}.wasm`);
  const zkeyPath = path.join(CIRCUIT_BUILD_PATH, `${circuitName}/${circuitName}.zkey`);

  if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
    throw new Error(
      `Circuit artifacts not found for ${circuitName}. ` +
      `Run: cd circuits && bash scripts/compile.sh && bash scripts/setup.sh`
    );
  }

  const tmpDir = path.join(CIRCUIT_BUILD_PATH, circuitName);
  const tmpInput = path.join(tmpDir, "_test_input.json");
  const tmpProof = path.join(tmpDir, "_test_proof.json");
  const tmpPublic = path.join(tmpDir, "_test_public.json");

  fs.writeFileSync(tmpInput, JSON.stringify(inputs));

  try {
    execSync(
      `node -e "
        const snarkjs = require('snarkjs');
        const fs = require('fs');
        (async () => {
          const input = JSON.parse(fs.readFileSync('${tmpInput}', 'utf8'));
          const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            '${wasmPath}',
            '${zkeyPath}'
          );
          fs.writeFileSync('${tmpProof}', JSON.stringify(proof));
          fs.writeFileSync('${tmpPublic}', JSON.stringify(publicSignals));
          process.exit(0);
        })().catch(e => { console.error(e); process.exit(1); });
      "`,
      { cwd: SDK_DIR, timeout: 120000 }
    );

    const proof = JSON.parse(fs.readFileSync(tmpProof, "utf8"));
    const publicSignals: string[] = JSON.parse(fs.readFileSync(tmpPublic, "utf8"));
    const proofBytes = serializeProof(proof);

    return { proof, publicSignals, proofBytes };
  } finally {
    try { fs.unlinkSync(tmpInput); } catch {}
    try { fs.unlinkSync(tmpProof); } catch {}
    try { fs.unlinkSync(tmpPublic); } catch {}
  }
}

/** Serialize snarkjs Groth16 proof to 256 bytes */
function serializeProof(proof: any): Uint8Array {
  const bytes = new Uint8Array(256);
  const piA = proof.pi_a;
  const piB = proof.pi_b;
  const piC = proof.pi_c;

  writeBigIntBE(bytes, 0, BigInt(piA[0]), 32);
  writeBigIntBE(bytes, 32, BigInt(piA[1]), 32);
  writeBigIntBE(bytes, 64, BigInt(piB[0][1]), 32);   // x_imag
  writeBigIntBE(bytes, 96, BigInt(piB[0][0]), 32);    // x_real
  writeBigIntBE(bytes, 128, BigInt(piB[1][1]), 32);   // y_imag
  writeBigIntBE(bytes, 160, BigInt(piB[1][0]), 32);   // y_real
  writeBigIntBE(bytes, 192, BigInt(piC[0]), 32);
  writeBigIntBE(bytes, 224, BigInt(piC[1]), 32);

  return bytes;
}

function writeBigIntBE(buf: Uint8Array, offset: number, value: bigint, length: number): void {
  for (let i = length - 1; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xFFn);
    value >>= 8n;
  }
}

/** Send @solana/kit transaction */
async function sendKitTransaction(
  ctx: E2ETestContext,
  instructions: Instruction[]
): Promise<string> {
  const { value: latestBlockhash } = await ctx.rpc.getLatestBlockhash().send();

  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc: ctx.rpc,
    rpcSubscriptions: ctx.rpcSubscriptions,
  });

  let msg = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(ctx.payerSigner.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
    (tx) => addSignersToTransactionMessage([ctx.payerSigner], tx),
  );

  const signedTx = await signTransactionMessageWithSigners(msg);
  await sendAndConfirm(signedTx, { commitment: "confirmed" });
  return getSignatureFromTransaction(signedTx);
}

// =============================================================================
// Test Suite
// =============================================================================

let ctx: E2ETestContext;
let skipTests = false;

describe.skip("Full E2E Flow — Groth16 Verification (DEPRECATED - uses legacy circuits)", () => {
  beforeAll(async () => {
    // Initialize Poseidon
    await initPoseidon();

    // Initialize test environment
    await initializeTestEnvironment();

    // Create test context
    ctx = await createTestContext();
    logTestEnvironment(ctx);

    // Check prerequisites
    if (ctx.skipOnChain) {
      console.warn("[SKIP] Validator not available — skipping on-chain tests");
      skipTests = true;
      return;
    }

    // Check circuits exist
    const claimWasm = path.join(CIRCUIT_BUILD_PATH, "claim/claim_js/claim.wasm");
    const sppWasm = path.join(CIRCUIT_BUILD_PATH, "spend_partial_public/spend_partial_public_js/spend_partial_public.wasm");
    if (!fs.existsSync(claimWasm) || !fs.existsSync(sppWasm)) {
      console.warn("[SKIP] Circuit artifacts not found — skipping proof tests");
      skipTests = true;
      return;
    }
  });

  // ===========================================================================
  // Test 1: Claim with Real Groth16 Proof
  // ===========================================================================

  test("Claim with real Groth16 proof", async () => {
    if (skipTests) {
      console.log("[SKIP] Test skipped — prerequisites not met");
      return;
    }

    const config = getConfig();
    const amount = 10_000n; // 0.001 BTC

    // 1. Generate test keys
    console.log("\n1. Generating test keys...");
    const recipientKeys = generateTestKeys("full-flow-claim-recipient");
    console.log(`   Spending key: ${recipientKeys.spendingPrivKey.toString(16).slice(0, 16)}...`);

    // 2. Create and submit stealth deposit
    console.log("\n2. Creating stealth deposit...");
    const testNote = await createAndSubmitStealthDeposit(ctx, recipientKeys, amount);
    console.log(`   Commitment: ${testNote.commitment.toString(16).slice(0, 16)}...`);
    console.log(`   Leaf index: ${testNote.leafIndex}`);

    // 3. Scan with viewing key and prepare claim
    console.log("\n3. Scanning and preparing claim...");
    const claimData = await scanAndPrepareClaim(ctx, recipientKeys, testNote.commitment);
    console.log(`   Merkle root: ${claimData.merkleProof.root.toString(16).slice(0, 16)}...`);
    console.log(`   Nullifier hash: ${claimData.nullifierHash.toString(16).slice(0, 16)}...`);

    // 4. Generate real Groth16 claim proof
    console.log("\n4. Generating Groth16 claim proof...");
    const recipientAddress = ctx.payerSigner.address;
    const recipientBigint = bytesToBigint(bs58Decode(recipientAddress.toString()));

    // BN254 field prime for reduction
    const BN254_FIELD_PRIME = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;
    const recipientReduced = recipientBigint % BN254_FIELD_PRIME;

    const { computeNullifierSync, hashNullifierSync } = await import("../../src/poseidon");
    const nullifier = computeNullifierSync(claimData.stealthPrivKey, BigInt(claimData.scannedNote.leafIndex));
    const nullifierHash = hashNullifierSync(nullifier);

    const circuitInputs = {
      priv_key: claimData.stealthPrivKey.toString(),
      amount: claimData.scannedNote.amount.toString(),
      leaf_index: claimData.scannedNote.leafIndex.toString(),
      merkle_path: claimData.merkleProof.siblings.map((s: bigint) => s.toString()),
      path_indices: claimData.merkleProof.indices,
      merkle_root: claimData.merkleProof.root.toString(),
      nullifier_hash: nullifierHash.toString(),
      amount_pub: claimData.scannedNote.amount.toString(),
      recipient: recipientReduced.toString(),
    };

    const proofStartTime = Date.now();
    const { proofBytes, publicSignals } = generateProofViaNode("claim", circuitInputs);
    const proofTime = ((Date.now() - proofStartTime) / 1000).toFixed(1);
    console.log(`   Proof generated in ${proofTime}s`);
    console.log(`   Proof size: ${proofBytes.length} bytes`);
    console.log(`   Public inputs: ${publicSignals.length}`);

    expect(proofBytes.length).toBe(256);
    expect(publicSignals.length).toBe(4);

    // 5. Create ATA for recipient
    console.log("\n5. Creating recipient ATA...");
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      ctx.connection,
      ctx.payer,
      new PublicKey(config.zbtcMint.toString()),
      ctx.payer.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    console.log(`   ATA: ${recipientAta.address.toBase58()}`);

    // 6. Build and submit claim instruction
    console.log("\n6. Building claim instruction...");
    const nullifierHashBytes = bigintToBytes(nullifierHash, 32);
    const [nullifierPda] = await deriveNullifierRecordPDA(
      nullifierHashBytes,
      config.aegisProgramId
    );

    const rootBytes = bigintToBytes(claimData.merkleProof.root, 32);
    const recipientReducedBytes = bigintToBytes(recipientReduced, 32);
    const vkHashBytes = hexToBytes(config.vkHashes.claim);

    const claimIx = buildClaimInstruction({
      proofBytes,
      root: rootBytes,
      nullifierHash: nullifierHashBytes,
      amountSats: amount,
      recipient: recipientAddress,
      vkHash: vkHashBytes,
      accounts: {
        poolState: config.poolStatePda,
        commitmentTree: config.commitmentTreePda,
        nullifierRecord: nullifierPda,
        zbtcMint: config.zbtcMint,
        poolVault: config.poolVault,
        recipientAta: address(recipientAta.address.toBase58()),
        user: ctx.payerSigner.address,
      },
    });

    // Add compute budget
    const computeBudgetIx: Instruction = {
      programAddress: address("ComputeBudget111111111111111111111111111111"),
      accounts: [],
      data: (() => {
        const d = new Uint8Array(9);
        d[0] = 2; // SetComputeUnitLimit
        new DataView(d.buffer).setUint32(1, 400_000, true);
        return d;
      })(),
    };

    console.log("\n7. Submitting claim transaction...");
    try {
      const sig = await sendKitTransaction(ctx, [computeBudgetIx, claimIx]);
      console.log(`   Claim TX: ${sig}`);

      // 8. Verify nullifier created
      const nullifierExists = await checkNullifierExists(ctx, nullifierHashBytes);
      console.log(`   Nullifier exists: ${nullifierExists}`);
      expect(nullifierExists).toBe(true);

      console.log("\n   CLAIM WITH GROTH16 PROOF SUCCEEDED!");
    } catch (error: any) {
      console.error(`   Claim failed: ${error.message}`);
      // Log transaction logs if available
      if (error.logs) {
        console.error("   Transaction logs:", error.logs);
      }
      throw error;
    }
  });

  // ===========================================================================
  // Test 2: Spend Partial Public with Real Groth16 Proof
  // ===========================================================================

  test("Spend partial public with real Groth16 proof", async () => {
    if (skipTests) {
      console.log("[SKIP] Test skipped — prerequisites not met");
      return;
    }

    const config = getConfig();
    const totalAmount = 10_000n; // matches DEMO_MINT_AMOUNT_SATS
    const publicAmount = 4_000n;  // claim publicly
    const changeAmount = 6_000n;  // change

    // 1. Generate test keys
    console.log("\n1. Generating test keys...");
    const recipientKeys = generateTestKeys("full-flow-spp-recipient");
    const changeKeys = generateTestKeys("full-flow-spp-change");

    // 2. Create and submit stealth deposit
    console.log("\n2. Creating stealth deposit...");
    const testNote = await createAndSubmitStealthDeposit(ctx, recipientKeys, totalAmount);
    console.log(`   Commitment: ${testNote.commitment.toString(16).slice(0, 16)}...`);

    // 3. Scan and prepare
    console.log("\n3. Scanning and preparing...");
    const claimData = await scanAndPrepareClaim(ctx, recipientKeys, testNote.commitment);

    // 4. Compute change commitment
    console.log("\n4. Computing change commitment...");
    // Use Baby Jubjub key derivation (matches in-circuit BabyPbk)
    const changePrivKey = changeKeys.spendingPrivKey;
    const changePubKeyX = babyJubMul(changePrivKey, BABYJUB_BASE8).x;
    const changeCommitment = computeUnifiedCommitmentSync(changePubKeyX, changeAmount);
    console.log(`   Change commitment: ${changeCommitment.toString(16).slice(0, 16)}...`);

    // 5. Generate Groth16 proof for spend_partial_public
    console.log("\n5. Generating spend_partial_public proof...");
    const recipientAddress = ctx.payerSigner.address;
    const recipientBigint = bytesToBigint(bs58Decode(recipientAddress.toString()));
    const BN254_FIELD_PRIME = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;
    const recipientReduced = recipientBigint % BN254_FIELD_PRIME;

    const { computeNullifierSync, hashNullifierSync } = await import("../../src/poseidon");
    const nullifier = computeNullifierSync(claimData.stealthPrivKey, BigInt(claimData.scannedNote.leafIndex));
    const nullifierHash = hashNullifierSync(nullifier);

    const circuitInputs = {
      priv_key: claimData.stealthPrivKey.toString(),
      amount: claimData.scannedNote.amount.toString(),
      leaf_index: claimData.scannedNote.leafIndex.toString(),
      merkle_path: claimData.merkleProof.siblings.map((s: bigint) => s.toString()),
      path_indices: claimData.merkleProof.indices,
      change_priv_key: changePrivKey.toString(),
      change_amount: changeAmount.toString(),
      merkle_root: claimData.merkleProof.root.toString(),
      nullifier_hash: nullifierHash.toString(),
      public_amount: publicAmount.toString(),
      change_commitment: changeCommitment.toString(),
      recipient: recipientReduced.toString(),
    };

    const proofStartTime = Date.now();
    const { proofBytes, publicSignals } = generateProofViaNode("spend_partial_public", circuitInputs);
    const proofTime = ((Date.now() - proofStartTime) / 1000).toFixed(1);
    console.log(`   Proof generated in ${proofTime}s`);
    console.log(`   Public inputs: ${publicSignals.length}`);

    expect(proofBytes.length).toBe(256);
    expect(publicSignals.length).toBe(5);

    // 6. Build instruction
    console.log("\n6. Building spend_partial_public instruction...");
    const nullifierHashBytes = bigintToBytes(nullifierHash, 32);
    const [nullifierPda] = await deriveNullifierRecordPDA(
      nullifierHashBytes,
      config.aegisProgramId
    );

    // Create ATA for recipient
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      ctx.connection,
      ctx.payer,
      new PublicKey(config.zbtcMint.toString()),
      ctx.payer.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // For change stealth announcement, use a random ephemeral key to avoid PDA collisions
    const randomEphemeralBytes = new Uint8Array(32);
    crypto.getRandomValues(randomEphemeralBytes);
    const changeEphemeralPubX = randomEphemeralBytes;
    const changeEncryptedAmountWithSign = new Uint8Array(32);
    // Pack change amount in little-endian (bits 0-63)
    const changeAmountView = new DataView(changeEncryptedAmountWithSign.buffer);
    changeAmountView.setBigUint64(0, changeAmount, true);
    // y_sign bit at bit 64 (byte 8, bit 0) = 0 (even y)

    // Derive stealth announcement PDA using ephemeral pub x (matching program)
    const [stealthAnnouncementPda] = await deriveStealthAnnouncementPDA(
      changeEphemeralPubX,
      config.aegisProgramId
    );

    const rootBytes = bigintToBytes(claimData.merkleProof.root, 32);
    const changeCommitmentBytes = bigintToBytes(changeCommitment, 32);
    const vkHashBytes = hexToBytes(config.vkHashes.spendPartialPublic);

    const sppIx = buildSpendPartialPublicInstruction({
      proofBytes,
      root: rootBytes,
      nullifierHash: nullifierHashBytes,
      publicAmountSats: publicAmount,
      changeCommitment: changeCommitmentBytes,
      recipient: recipientAddress,
      vkHash: vkHashBytes,
      changeEphemeralPubX,
      changeEncryptedAmountWithSign,
      accounts: {
        poolState: config.poolStatePda,
        commitmentTree: config.commitmentTreePda,
        nullifierRecord: nullifierPda,
        zbtcMint: config.zbtcMint,
        poolVault: config.poolVault,
        recipientAta: address(recipientAta.address.toBase58()),
        user: ctx.payerSigner.address,
        stealthAnnouncementChange: stealthAnnouncementPda,
      },
    });

    // Compute budget
    const computeBudgetIx: Instruction = {
      programAddress: address("ComputeBudget111111111111111111111111111111"),
      accounts: [],
      data: (() => {
        const d = new Uint8Array(9);
        d[0] = 2; // SetComputeUnitLimit
        new DataView(d.buffer).setUint32(1, 400_000, true);
        return d;
      })(),
    };

    console.log("\n7. Submitting spend_partial_public transaction...");
    try {
      const sig = await sendKitTransaction(ctx, [computeBudgetIx, sppIx]);
      console.log(`   SPP TX: ${sig}`);

      // Verify nullifier created
      const nullifierExists = await checkNullifierExists(ctx, nullifierHashBytes);
      console.log(`   Nullifier exists: ${nullifierExists}`);
      expect(nullifierExists).toBe(true);

      console.log("\n   SPEND PARTIAL PUBLIC WITH GROTH16 PROOF SUCCEEDED!");
    } catch (error: any) {
      console.error(`   SPP failed: ${error.message}`);
      if (error.logs) {
        console.error("   Transaction logs:", error.logs);
      }
      throw error;
    }
  });

  // ===========================================================================
  // Test 3: Chained Flow — Deposit → Claim → Verify Balance
  // ===========================================================================

  test("Chained flow: deposit → claim → verify balance", async () => {
    if (skipTests) {
      console.log("[SKIP] Test skipped — prerequisites not met");
      return;
    }

    const config = getConfig();
    const amount = 10_000n;

    // 1. Get initial balance
    console.log("\n1. Checking initial balance...");
    const initialBalance = await getTokenBalance(ctx, ctx.payer.publicKey);
    console.log(`   Initial zkBTC: ${initialBalance}`);

    // 2. Deposit
    console.log("\n2. Creating deposit...");
    const recipientKeys = generateTestKeys("full-flow-chained-" + Date.now());
    const testNote = await createAndSubmitStealthDeposit(ctx, recipientKeys, amount);

    // 3. Prepare claim
    console.log("\n3. Preparing claim...");
    const claimData = await scanAndPrepareClaim(ctx, recipientKeys, testNote.commitment);

    // 4. Generate proof
    console.log("\n4. Generating proof...");
    const recipientAddress = ctx.payerSigner.address;
    const recipientBigint = bytesToBigint(bs58Decode(recipientAddress.toString()));
    const BN254_FIELD_PRIME = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;
    const recipientReduced = recipientBigint % BN254_FIELD_PRIME;

    const { computeNullifierSync, hashNullifierSync } = await import("../../src/poseidon");
    const nullifier = computeNullifierSync(claimData.stealthPrivKey, BigInt(claimData.scannedNote.leafIndex));
    const nullifierHash = hashNullifierSync(nullifier);

    const { proofBytes } = generateProofViaNode("claim", {
      priv_key: claimData.stealthPrivKey.toString(),
      amount: amount.toString(),
      leaf_index: claimData.scannedNote.leafIndex.toString(),
      merkle_path: claimData.merkleProof.siblings.map((s: bigint) => s.toString()),
      path_indices: claimData.merkleProof.indices,
      merkle_root: claimData.merkleProof.root.toString(),
      nullifier_hash: nullifierHash.toString(),
      amount_pub: amount.toString(),
      recipient: recipientReduced.toString(),
    });

    // 5. Submit claim
    console.log("\n5. Submitting claim...");
    const nullifierHashBytes = bigintToBytes(nullifierHash, 32);
    const [nullifierPda] = await deriveNullifierRecordPDA(nullifierHashBytes, config.aegisProgramId);

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      ctx.connection,
      ctx.payer,
      new PublicKey(config.zbtcMint.toString()),
      ctx.payer.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    const computeBudgetIx: Instruction = {
      programAddress: address("ComputeBudget111111111111111111111111111111"),
      accounts: [],
      data: (() => {
        const d = new Uint8Array(9);
        d[0] = 2;
        new DataView(d.buffer).setUint32(1, 400_000, true);
        return d;
      })(),
    };

    const claimIx = buildClaimInstruction({
      proofBytes,
      root: bigintToBytes(claimData.merkleProof.root, 32),
      nullifierHash: nullifierHashBytes,
      amountSats: amount,
      recipient: recipientAddress,
      vkHash: hexToBytes(config.vkHashes.claim),
      accounts: {
        poolState: config.poolStatePda,
        commitmentTree: config.commitmentTreePda,
        nullifierRecord: nullifierPda,
        zbtcMint: config.zbtcMint,
        poolVault: config.poolVault,
        recipientAta: address(recipientAta.address.toBase58()),
        user: ctx.payerSigner.address,
      },
    });

    const sig = await sendKitTransaction(ctx, [computeBudgetIx, claimIx]);
    console.log(`   Claim TX: ${sig}`);

    // 6. Verify balance increased
    console.log("\n6. Verifying balance...");
    const finalBalance = await getTokenBalance(ctx, ctx.payer.publicKey);
    console.log(`   Final zkBTC: ${finalBalance}`);
    console.log(`   Difference: ${finalBalance - initialBalance}`);

    expect(finalBalance - initialBalance).toBe(amount);
    console.log("\n   CHAINED FLOW SUCCEEDED!");
  });
});

// =============================================================================
// Utility
// =============================================================================

/** Simple base58 decode */
function bs58Decode(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const ALPHABET_MAP = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_MAP.set(ALPHABET[i], i);
  }

  let num = BigInt(0);
  for (const char of str) {
    const val = ALPHABET_MAP.get(char);
    if (val === undefined) throw new Error(`Invalid base58 character: ${char}`);
    num = num * BigInt(58) + BigInt(val);
  }

  let leadingZeros = 0;
  for (const char of str) {
    if (char === "1") leadingZeros++;
    else break;
  }

  const bytes: number[] = [];
  while (num > BigInt(0)) {
    bytes.unshift(Number(num % BigInt(256)));
    num = num / BigInt(256);
  }

  for (let i = 0; i < leadingZeros; i++) bytes.unshift(0);
  while (bytes.length < 32) bytes.unshift(0);

  return new Uint8Array(bytes);
}
