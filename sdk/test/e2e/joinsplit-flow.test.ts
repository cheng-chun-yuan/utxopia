/**
 * E2E Test: JoinSplit Full Flow (SDK-driven)
 *
 * Tests the full JoinSplit lifecycle using SDK functions:
 * 1. Derive keys from seed (spending, nullifying, viewing)
 * 2. Create a demo deposit (commitment in on-chain Merkle tree)
 * 3. Build commitment tree from chain
 * 4. Get Merkle proof for the commitment
 * 5. EdDSA-Poseidon sign (via circomlibjs)
 * 6. Generate real Groth16 proof via SDK's generateJoinSplitProof
 * 7. Build and submit transact instruction on-chain
 * 8. Verify: nullifier PDA created, tree updated, stealth announcement exists
 *
 * Prerequisites:
 * - Solana devnet connectivity (or solana-test-validator with BN254 support)
 * - Circuit artifacts in sdk/circuits/joinsplit_1x1/
 * - Funded payer keypair
 *
 * Run: NETWORK=devnet bun test test/e2e/joinsplit-flow.test.ts
 */

import { describe, test, expect, beforeAll, setDefaultTimeout } from "bun:test";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { buildEddsa } from "circomlibjs";

import {
  createTestContext,
  initializeTestEnvironment,
  logTestEnvironment,
  type E2ETestContext,
  PROOF_TIMEOUT,
} from "./setup";

// SDK imports
import {
  initPoseidon,
  poseidonHashSync,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
  computeMPKSync,
} from "../../src/poseidon";
import {
  randomFieldElement,
  bigintToBytes,
  bytesToBigint,
  BN254_FIELD_PRIME,
} from "../../src/crypto";
import {
  generateJoinSplitProof,
  proofToBytes,
  setCircuitPath,
  initProver,
} from "../../src/prover/web";
import {
  buildTransactInstruction,
  bigintTo32Bytes,
  type TransactInstructionOptions,
} from "../../src/instructions";
import {
  buildAddDemoStealthData,
} from "../../src/demo";
import {
  computeBoundParamsHash,
  DEFAULT_BOUND_PARAMS,
} from "../../src/bound-params";
import {
  DEVNET_CONFIG,
  getConfig,
  setConfig,
} from "../../src/config";
import {
  deriveNullifierRecordPDA,
  deriveVkRegistryPDA,
} from "../../src/pda";
import {
  buildCommitmentTreeFromChain,
  getMerkleProofFromTree,
  parseCommitmentTreeData,
} from "../../src/commitment-tree";
import { address } from "@solana/kit";

// Proof generation can take minutes
setDefaultTimeout(PROOF_TIMEOUT);

// =============================================================================
// Constants
// =============================================================================

const ZKBTC_TOKEN_ID = 0x7a627463n; // "zkbtc" as u32

// =============================================================================
// EdDSA-Poseidon Helpers (via circomlibjs)
// =============================================================================

let eddsaInstance: any = null;

async function initEddsa() {
  if (!eddsaInstance) {
    eddsaInstance = await buildEddsa();
  }
  return eddsaInstance;
}

/**
 * Generate EdDSA key pair using circomlibjs.
 * circomlibjs internally hashes the seed (like standard EdDSA),
 * producing keys compatible with the EdDSAPoseidonVerifier circuit.
 */
async function generateEddsaKeyPair(seed: Uint8Array): Promise<{
  privKeyBuf: Buffer;
  pubKeyX: bigint;
  pubKeyY: bigint;
}> {
  const eddsa = await initEddsa();
  const F = eddsa.babyJub.F;

  const privKeyBuf = Buffer.from(seed);
  const pubKey = eddsa.prv2pub(privKeyBuf);
  const pubKeyX = F.toObject(pubKey[0]) as bigint;
  const pubKeyY = F.toObject(pubKey[1]) as bigint;

  return { privKeyBuf, pubKeyX, pubKeyY };
}

/**
 * Sign a message with EdDSA-Poseidon (circomlibjs)
 */
async function eddsaPoseidonSign(
  privKeyBuf: Buffer,
  msg: bigint,
): Promise<[bigint, bigint, bigint]> {
  const eddsa = await initEddsa();
  const F = eddsa.babyJub.F;

  const msgF = F.e(msg);
  const signature = eddsa.signPoseidon(privKeyBuf, msgF);

  const R8x = F.toObject(signature.R8[0]) as bigint;
  const R8y = F.toObject(signature.R8[1]) as bigint;
  const S = signature.S as bigint;

  return [R8x, R8y, S];
}

// =============================================================================
// Test Suite
// =============================================================================

let ctx: E2ETestContext;
let skipTests = false;

describe("JoinSplit Full Flow — SDK-driven E2E", () => {
  beforeAll(async () => {
    // Initialize Poseidon
    await initPoseidon();

    // Initialize test environment (sets circuit path, checks prover)
    const env = await initializeTestEnvironment();

    // Create test context
    ctx = await createTestContext();
    logTestEnvironment(ctx);

    if (ctx.skipOnChain) {
      console.warn("[SKIP] Validator/devnet not available — skipping on-chain tests");
      skipTests = true;
      return;
    }

    if (!env.circuitsAvailable.joinsplit) {
      console.warn("[SKIP] joinsplit_1x1 circuit not found — skipping proof tests");
      skipTests = true;
      return;
    }

    if (!env.proverReady) {
      console.warn("[SKIP] Prover not ready — skipping proof tests");
      skipTests = true;
      return;
    }

    // Initialize EdDSA
    await initEddsa();
    console.log("[Setup] EdDSA-Poseidon initialized");
  });

  test("JoinSplit 1x1: demo deposit → proof → transact → verify", async () => {
    if (skipTests) {
      console.log("[SKIP] Prerequisites not met");
      return;
    }

    const config = getConfig();
    const connection = ctx.connection;
    const payer = ctx.payer;
    const inputAmount = 10_000n; // 0.0001 BTC (matches DEMO_MINT_AMOUNT_SATS)

    console.log("\n" + "=".repeat(60));
    console.log("JoinSplit 1x1 Full Flow Test");
    console.log("=".repeat(60));

    // =========================================================================
    // Step 1: Generate keys via circomlibjs EdDSA
    // =========================================================================
    console.log("\n1. Generating EdDSA keys...");

    // Generate a random 32-byte seed for the spending key
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);

    const { privKeyBuf, pubKeyX, pubKeyY } = await generateEddsaKeyPair(seed);
    console.log(`   PubKey X: ${pubKeyX.toString(16).slice(0, 20)}...`);
    console.log(`   PubKey Y: ${pubKeyY.toString(16).slice(0, 20)}...`);

    // Derive nullifying key from seed (hash it to get a BN254 scalar)
    const nullifyingSeed = new Uint8Array(32);
    crypto.getRandomValues(nullifyingSeed);
    const nullifyingKey = bytesToBigint(nullifyingSeed) % BN254_FIELD_PRIME;
    console.log(`   Nullifying key: ${nullifyingKey.toString(16).slice(0, 20)}...`);

    // Compute MPK = Poseidon(pubKeyX, pubKeyY, nullifyingKey)
    const mpk = computeMPKSync(pubKeyX, pubKeyY, nullifyingKey);
    console.log(`   MPK: ${mpk.toString(16).slice(0, 20)}...`);

    // =========================================================================
    // Step 2: Compute input note (for demo deposit)
    // =========================================================================
    console.log("\n2. Computing input note...");

    const inputRandom = randomFieldElement();
    const npkIn = poseidonHashSync([mpk, inputRandom]);
    const commitmentIn = computeJoinSplitCommitmentSync(npkIn, ZKBTC_TOKEN_ID, inputAmount);
    console.log(`   Input random: ${inputRandom.toString(16).slice(0, 20)}...`);
    console.log(`   Input NPK: ${npkIn.toString(16).slice(0, 20)}...`);
    console.log(`   Input commitment: ${commitmentIn.toString(16).slice(0, 20)}...`);

    // =========================================================================
    // Step 3: Submit demo deposit on-chain
    // =========================================================================
    console.log("\n3. Submitting demo deposit...");

    const ephemeralPub = new Uint8Array(32);
    crypto.getRandomValues(ephemeralPub);

    const npkBytes = bigintTo32Bytes(npkIn);
    const demoData = buildAddDemoStealthData(ephemeralPub, npkBytes, inputAmount);

    // Derive PDAs for the demo instruction
    const programId = new PublicKey(config.utxopiaProgramId.toString());
    const poolState = new PublicKey(config.poolStatePda.toString());
    const commitmentTree = new PublicKey(config.commitmentTreePda.toString());
    const zkbtcMint = new PublicKey(config.zkbtcMint.toString());
    const poolVault = new PublicKey(config.poolVault.toString());
    const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

    // Stealth announcement PDA: seeds = ["stealth", ephemeralPub]
    const [stealthAnnPdaDeposit] = PublicKey.findProgramAddressSync(
      [Buffer.from("stealth"), Buffer.from(ephemeralPub)],
      programId,
    );

    const demoIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: poolState, isSigner: false, isWritable: true },
        { pubkey: commitmentTree, isSigner: false, isWritable: true },
        { pubkey: stealthAnnPdaDeposit, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: PublicKey.default, isSigner: false, isWritable: false }, // system program
        { pubkey: zkbtcMint, isSigner: false, isWritable: true },
        { pubkey: poolVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(demoData),
    });

    const demoTx = new Transaction().add(demoIx);
    const demoSig = await sendAndConfirmTransaction(connection, demoTx, [payer], {
      commitment: "confirmed",
    });
    console.log(`   Demo deposit TX: ${demoSig.slice(0, 20)}...`);

    // =========================================================================
    // Step 4: Build commitment tree from chain & get Merkle proof
    // =========================================================================
    console.log("\n4. Building commitment tree from chain...");

    // Fetch tree state to get maxLeafIndex (filter stale announcements)
    const commitmentTreePubkey = new PublicKey(config.commitmentTreePda.toString());
    const treeAccount = await connection.getAccountInfo(commitmentTreePubkey);
    let maxLeafIndex: number | undefined;
    if (treeAccount) {
      const treeState = parseCommitmentTreeData(new Uint8Array(treeAccount.data));
      maxLeafIndex = Number(treeState.nextIndex);
      console.log(`   On-chain tree nextIndex: ${maxLeafIndex}`);
    }

    // Build tree from on-chain announcements
    const tree = await buildCommitmentTreeFromChain(
      {
        getProgramAccounts: async (progId, rpcConfig) => {
          const filters = rpcConfig?.filters
            ?.map((f: any) => {
              if (f.memcmp) return { memcmp: { offset: f.memcmp.offset, bytes: f.memcmp.bytes } };
              if (f.dataSize !== undefined) return { dataSize: f.dataSize };
              return null;
            })
            .filter((f: any): f is NonNullable<typeof f> => f !== null);

          const accounts = await connection.getProgramAccounts(
            new PublicKey(progId),
            { filters },
          );
          return accounts.map((acc) => ({
            pubkey: acc.pubkey.toBase58(),
            account: { data: acc.account.data },
          }));
        },
      },
      config.utxopiaProgramId.toString(),
      maxLeafIndex !== undefined ? { maxLeafIndex } : undefined,
    );

    console.log(`   Tree built with ${tree.size()} commitments`);

    // Get proof for our commitment
    const proof = getMerkleProofFromTree(tree, commitmentIn);
    if (!proof) {
      throw new Error(
        `Commitment not found in tree! Looking for: ${commitmentIn.toString(16).padStart(64, "0")}`
      );
    }
    console.log(`   Found at leaf index: ${proof.leafIndex}`);
    console.log(`   Merkle root: ${proof.root.toString(16).slice(0, 20)}...`);

    // Fetch on-chain root for verification
    const treeAccountAfterDeposit = await connection.getAccountInfo(commitmentTreePubkey);
    let onChainRoot: bigint;
    if (treeAccountAfterDeposit) {
      const treeState = parseCommitmentTreeData(new Uint8Array(treeAccountAfterDeposit.data));
      onChainRoot = bytesToBigint(treeState.currentRoot);
      console.log(`   On-chain root: ${onChainRoot.toString(16).slice(0, 20)}...`);
      console.log(`   Roots match: ${onChainRoot === proof.root}`);
    } else {
      onChainRoot = proof.root;
    }

    // Use the on-chain root (may differ from computed if there are timing issues)
    const merkleRoot = onChainRoot;

    // =========================================================================
    // Step 5: Compute circuit inputs
    // =========================================================================
    console.log("\n5. Computing circuit inputs...");

    // Output note: same amount, new random (1-in-1-out private refresh)
    const outputRandom = randomFieldElement();
    const npkOut = poseidonHashSync([mpk, outputRandom]);
    const commitmentOut = computeJoinSplitCommitmentSync(npkOut, ZKBTC_TOKEN_ID, inputAmount);
    console.log(`   Output NPK: ${npkOut.toString(16).slice(0, 20)}...`);
    console.log(`   Output commitment: ${commitmentOut.toString(16).slice(0, 20)}...`);

    // Compute nullifier = Poseidon(nullifyingKey, leafIndex)
    const nullifier = computeJoinSplitNullifierSync(nullifyingKey, proof.leafIndex);
    console.log(`   Nullifier: ${nullifier.toString(16).slice(0, 20)}...`);

    // Bound params hash (private transfer, devnet)
    const boundParamsHash = computeBoundParamsHash(DEFAULT_BOUND_PARAMS);
    console.log(`   Bound params hash: ${boundParamsHash.toString(16).slice(0, 20)}...`);

    // Compute message hash for EdDSA signature
    const msgHash = poseidonHashSync([merkleRoot, boundParamsHash, nullifier, commitmentOut]);

    // =========================================================================
    // Step 6: EdDSA-Poseidon sign
    // =========================================================================
    console.log("\n6. Signing with EdDSA-Poseidon...");
    const [sigR8x, sigR8y, sigS] = await eddsaPoseidonSign(privKeyBuf, msgHash);
    console.log(`   Signature R8x: ${sigR8x.toString(16).slice(0, 20)}...`);

    // =========================================================================
    // Step 7: Generate Groth16 proof via SDK
    // =========================================================================
    console.log("\n7. Generating Groth16 proof...");
    const proofStartTime = Date.now();

    const proofData = await generateJoinSplitProof({
      nInputs: 1,
      nOutputs: 1,
      merkleRoot,
      boundParamsHash,
      token: ZKBTC_TOKEN_ID,
      publicKey: [pubKeyX, pubKeyY],
      signature: [sigR8x, sigR8y, sigS],
      nullifyingKey,
      inputs: [{
        random: inputRandom,
        value: inputAmount,
        leafIndex: proof.leafIndex,
        merkleProof: {
          siblings: proof.siblings,
          indices: proof.indices,
        },
      }],
      outputs: [{
        npk: npkOut,
        value: inputAmount,
      }],
    });

    const proofBytes = proofToBytes(proofData);
    const proofTime = ((Date.now() - proofStartTime) / 1000).toFixed(1);
    console.log(`   Proof generated in ${proofTime}s`);
    console.log(`   Proof size: ${proofBytes.length} bytes`);
    expect(proofBytes.length).toBe(256);

    // =========================================================================
    // Step 8: Build and submit transact instruction via SDK
    // =========================================================================
    console.log("\n8. Submitting transact instruction...");

    const nullifierBytes = bigintTo32Bytes(nullifier);
    const commitmentOutBytes = bigintTo32Bytes(commitmentOut);
    const merkleRootBytes = bigintTo32Bytes(merkleRoot);
    const boundParamsHashBytes = bigintTo32Bytes(boundParamsHash);

    // Derive PDAs
    const [nullifierPDA] = await deriveNullifierRecordPDA(nullifierBytes);
    console.log(`   Nullifier PDA: ${nullifierPDA.slice(0, 20)}...`);

    // Output stealth data
    const outputEphemeralPub = new Uint8Array(32);
    crypto.getRandomValues(outputEphemeralPub);
    const outputEncryptedAmount = new Uint8Array(8);
    let amt = inputAmount;
    for (let i = 0; i < 8; i++) {
      outputEncryptedAmount[i] = Number(amt & 0xffn);
      amt >>= 8n;
    }

    // Stealth data = ephemeralPub(32) + encryptedAmount(8) = 40 bytes
    const stealthDataBuf = new Uint8Array(40);
    stealthDataBuf.set(outputEphemeralPub, 0);
    stealthDataBuf.set(outputEncryptedAmount, 32);

    // Stealth announcements are now emitted as events (sol_log_data), no PDA needed

    // VK registry PDA for joinsplit_1x1
    const [vkRegistryPDA] = await deriveVkRegistryPDA(1, 1);
    console.log(`   VK registry PDA: ${vkRegistryPDA.slice(0, 20)}...`);

    // Build transact instruction using SDK
    const transactIx = buildTransactInstruction({
      nInputs: 1,
      nOutputs: 1,
      proofBytes,
      merkleRoot: merkleRootBytes,
      boundParamsHash: boundParamsHashBytes,
      nullifiers: [nullifierBytes],
      commitmentsOut: [commitmentOutBytes],
      stealthData: [stealthDataBuf],
      accounts: {
        poolState: address(config.poolStatePda.toString()),
        commitmentTree: address(config.commitmentTreePda.toString()),
        vkRegistry: vkRegistryPDA,
        user: address(payer.publicKey.toBase58()),
        nullifierRecords: [nullifierPDA],
        stealthAnnouncements: [stealthAnnPDA],
      },
    });

    // Convert @solana/kit instruction to @solana/web3.js for submission
    // AccountRole: READONLY=0, READONLY_SIGNER=2, WRITABLE=1, WRITABLE_SIGNER=3
    const web3Ix = new TransactionInstruction({
      programId: new PublicKey(transactIx.programAddress.toString()),
      keys: transactIx.accounts.map((acc: any) => ({
        pubkey: new PublicKey(acc.address.toString()),
        isSigner: acc.role === 2 || acc.role === 3, // READONLY_SIGNER or WRITABLE_SIGNER
        isWritable: acc.role === 1 || acc.role === 3, // WRITABLE or WRITABLE_SIGNER
      })),
      data: Buffer.from(transactIx.data),
    });

    // Add compute budget (JoinSplit needs more CU)
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000,
    });

    try {
      const tx = new Transaction().add(computeBudgetIx, web3Ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      console.log(`   Transaction confirmed: ${sig.slice(0, 20)}...`);
    } catch (err: any) {
      console.error(`   Transaction FAILED: ${err.message?.slice(0, 300)}`);
      if (err.logs) {
        console.error("   Program logs:");
        for (const log of err.logs) {
          console.error(`     ${log}`);
        }
      }
      throw err;
    }

    // =========================================================================
    // Step 9: Verify on-chain state
    // =========================================================================
    console.log("\n9. Verifying on-chain state...");

    // Check nullifier PDA exists
    const nullifierInfo = await connection.getAccountInfo(
      new PublicKey(nullifierPDA.toString())
    );
    expect(nullifierInfo).not.toBeNull();
    expect(nullifierInfo!.data[0]).toBe(0x03); // Nullifier record discriminator
    console.log("   Nullifier PDA exists with correct discriminator (0x03)");

    // Check nullifier operation type = PrivateTransfer (2)
    expect(nullifierInfo!.data[1]).toBe(2);
    console.log("   Nullifier operation type: PrivateTransfer (2)");

    // Check stealth announcement PDA exists
    const stealthInfo = await connection.getAccountInfo(
      new PublicKey(stealthAnnPDA.toString())
    );
    expect(stealthInfo).not.toBeNull();
    expect(stealthInfo!.data[0]).toBe(0x08); // Stealth announcement discriminator
    console.log("   Stealth announcement PDA exists with correct discriminator (0x08)");

    // Check commitment tree index increased
    const treeInfoAfter = await connection.getAccountInfo(commitmentTreePubkey);
    if (treeInfoAfter) {
      const treeAfter = parseCommitmentTreeData(new Uint8Array(treeInfoAfter.data));
      console.log(`   Commitment tree nextIndex after: ${treeAfter.nextIndex}`);
      // nextIndex should have increased by 1 (one new output commitment)
      expect(Number(treeAfter.nextIndex)).toBeGreaterThan(Number(proof.leafIndex));
    }

    console.log("\n" + "=".repeat(60));
    console.log("ALL CHECKS PASSED");
    console.log("=".repeat(60));
    console.log("- Real Groth16 proof generated via SDK");
    console.log("- Transact instruction built via SDK");
    console.log("- Nullifier PDA created (double-spend protection)");
    console.log("- Stealth announcement PDA created (output notification)");
    console.log("- Commitment tree updated with new output");
    console.log("=".repeat(60));
  });
});
