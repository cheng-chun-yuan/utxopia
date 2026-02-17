/**
 * Stealth Helpers for E2E Tests
 *
 * Provides utilities for creating stealth deposits, scanning announcements,
 * and preparing claim inputs for real proof generation.
 *
 * Full stealth flow:
 * 1. Generate keys (deriveKeysFromSeed)
 * 2. Create stealth deposit (createStealthDeposit)
 * 3. Submit via demo instruction (ADD_DEMO_STEALTH)
 * 4. Fetch on-chain tree (buildCommitmentTreeFromChain)
 * 5. Scan for notes (scanAnnouncements)
 * 6. Prepare claim inputs (prepareClaimInputs)
 */

import { PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  address,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  AccountRole,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";

import type { E2ETestContext } from "./setup";
import { deriveKeysFromSeed, createStealthMetaAddress, type ZVaultKeys, type StealthMetaAddress } from "../../src/keys";
import { createStealthDeposit, scanAnnouncements, prepareClaimInputs, type StealthDeposit, type ScannedNote, type ClaimInputs } from "../../src/stealth";
import { buildAddDemoStealthData, DEMO_INSTRUCTION } from "../../src/demo";
import { buildCommitmentTreeFromChain, getMerkleProofFromTree, type OnChainMerkleProof, type CommitmentTreeIndex } from "../../src/commitment-tree";
import { deriveCommitmentTreePDA, deriveStealthAnnouncementPDA } from "../../src/pda";
import { bytesToBigint, bigintToBytes } from "../../src/crypto";
import { hashNullifierSync, computeNullifierSync } from "../../src/poseidon";

// =============================================================================
// Types
// =============================================================================

/**
 * Complete test stealth note with all data needed for testing
 */
export interface TestStealthNote {
  /** Recipient keys (needed for scanning and claiming) */
  recipientKeys: ZVaultKeys;
  /** Stealth deposit data */
  deposit: StealthDeposit;
  /** Amount in satoshis */
  amount: bigint;
  /** Commitment as bigint */
  commitment: bigint;
  /** Commitment as bytes */
  commitmentBytes: Uint8Array;
  /** Leaf index in tree (set after on-chain submission) */
  leafIndex?: number;
  /** Scanned note (set after scanning) */
  scannedNote?: ScannedNote;
}

/**
 * Prepared claim data ready for proof generation
 */
export interface PreparedClaimData {
  /** Scanned note with amount and stealth keys */
  scannedNote: ScannedNote;
  /** Merkle proof from on-chain tree */
  merkleProof: OnChainMerkleProof;
  /** Nullifier hash (for PDA derivation) */
  nullifierHash: bigint;
  /** Nullifier hash as bytes */
  nullifierHashBytes: Uint8Array;
  /** Stealth private key (for ZK proof) */
  stealthPrivKey: bigint;
  /** Stealth public key X coordinate (for ZK proof) */
  stealthPubKeyX: bigint;
}

// =============================================================================
// Key Generation
// =============================================================================

/**
 * Generate deterministic test keys from a seed string
 *
 * Uses deriveKeysFromSeed with SHA256 of the seed string.
 * Same seed always produces same keys (deterministic for testing).
 *
 * @param seed - Seed string (e.g., "recipient-1", "sender-test")
 * @returns ZVaultKeys with spending and viewing keys
 */
export function generateTestKeys(seed: string): ZVaultKeys {
  const encoder = new TextEncoder();
  const seedBytes = encoder.encode(seed);
  return deriveKeysFromSeed(seedBytes);
}

// =============================================================================
// Stealth Deposit Creation
// =============================================================================

/**
 * Create a stealth deposit for a recipient
 *
 * @param recipientKeys - Recipient's ZVault keys
 * @param amount - Amount in satoshis
 * @returns TestStealthNote with deposit data
 */
export async function createTestStealthDeposit(
  recipientKeys: ZVaultKeys,
  amount: bigint
): Promise<TestStealthNote> {
  // Create stealth meta-address from recipient keys
  const metaAddress = createStealthMetaAddress(recipientKeys);

  // Create stealth deposit (generates ephemeral key, computes commitment)
  const deposit = await createStealthDeposit(metaAddress, amount);

  // Extract commitment as bigint
  const commitment = bytesToBigint(deposit.commitment);

  return {
    recipientKeys,
    deposit,
    amount,
    commitment,
    commitmentBytes: deposit.commitment,
  };
}

/**
 * Submit a stealth deposit to on-chain tree via demo instruction
 *
 * @param ctx - E2E test context
 * @param testNote - Test stealth note to submit
 * @returns Transaction signature
 */
export async function submitDemoStealthDeposit(
  ctx: E2ETestContext,
  testNote: TestStealthNote
): Promise<string> {
  const zvaultProgramId = new PublicKey(ctx.localnetConfig.programs.zVault);
  const commitmentTreePda = new PublicKey(ctx.localnetConfig.accounts.commitmentTree);
  const poolStatePda = new PublicKey(ctx.localnetConfig.accounts.poolState);

  // Derive stealth announcement PDA
  // Ed25519 ephemeral pub is already 32 bytes, use directly
  const [announcementPda] = await deriveStealthAnnouncementPDA(
    testNote.deposit.ephemeralPub,
    address(ctx.localnetConfig.programs.zVault)
  );

  // Build instruction data
  // Encrypted amount as 8 bytes (little-endian)
  const encryptedAmount = testNote.deposit.encryptedAmount;

  const instructionData = buildAddDemoStealthData(
    testNote.deposit.ephemeralPub,
    testNote.commitmentBytes,
    encryptedAmount
  );

  // Token-2022 Program ID
  const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

  // Create instruction
  // Account order must match program expectation:
  // 1. poolState, 2. commitmentTree, 3. stealthAnnouncement, 4. authority (signer)
  // 5. systemProgram, 6. zbtcMint, 7. poolVault, 8. token2022Program
  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: poolStatePda, isSigner: false, isWritable: true },
      { pubkey: commitmentTreePda, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(announcementPda.toString()), isSigner: false, isWritable: true },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(ctx.localnetConfig.accounts.zkbtcMint), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(ctx.localnetConfig.accounts.poolVault), isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: zvaultProgramId,
    data: Buffer.from(instructionData),
  });

  // Submit transaction
  const tx = new Transaction().add(instruction);
  const signature = await sendAndConfirmTransaction(ctx.connection, tx, [ctx.payer], {
    commitment: "confirmed",
  });

  console.log(`[StealthHelper] Demo stealth deposit submitted: ${signature}`);
  console.log(`[StealthHelper] Commitment: ${testNote.commitment.toString(16).slice(0, 16)}...`);

  return signature;
}

/**
 * Create and submit a stealth deposit in one call
 *
 * @param ctx - E2E test context
 * @param recipientKeys - Recipient's ZVault keys
 * @param amount - Amount in satoshis
 * @returns TestStealthNote with leaf index set
 */
export async function createAndSubmitStealthDeposit(
  ctx: E2ETestContext,
  recipientKeys: ZVaultKeys,
  amount: bigint
): Promise<TestStealthNote> {
  // Create the deposit
  const testNote = await createTestStealthDeposit(recipientKeys, amount);

  // Submit to on-chain tree
  await submitDemoStealthDeposit(ctx, testNote);

  // Fetch the leaf index from on-chain
  const tree = await buildCommitmentTreeFromChain(
    {
      getProgramAccounts: async (programId, config) => {
        const accounts = await ctx.connection.getProgramAccounts(
          new PublicKey(programId),
          {
            filters: config?.filters?.map((f) => {
              if ("memcmp" in f) {
                return { memcmp: { offset: f.memcmp.offset, bytes: f.memcmp.bytes } };
              }
              if ("dataSize" in f) {
                return { dataSize: f.dataSize };
              }
              return f;
            }),
          }
        );
        return accounts.map((acc) => ({
          pubkey: acc.pubkey.toBase58(),
          account: { data: acc.account.data },
        }));
      },
    },
    ctx.localnetConfig.programs.zVault
  );

  // Find the leaf index for our commitment
  const proof = getMerkleProofFromTree(tree, testNote.commitment);
  if (proof) {
    testNote.leafIndex = proof.leafIndex;
    console.log(`[StealthHelper] Commitment added at leaf index: ${testNote.leafIndex}`);
  } else {
    console.warn(`[StealthHelper] Could not find commitment in tree`);
  }

  return testNote;
}

// =============================================================================
// On-Chain Tree and Merkle Proof
// =============================================================================

/**
 * Fetch on-chain commitment tree
 *
 * @param ctx - E2E test context
 * @returns CommitmentTreeIndex built from on-chain data
 */
export async function fetchOnChainTree(
  ctx: E2ETestContext
): Promise<CommitmentTreeIndex> {
  return buildCommitmentTreeFromChain(
    {
      getProgramAccounts: async (programId, config) => {
        const accounts = await ctx.connection.getProgramAccounts(
          new PublicKey(programId),
          {
            filters: config?.filters?.map((f) => {
              if ("memcmp" in f) {
                return { memcmp: { offset: f.memcmp.offset, bytes: f.memcmp.bytes } };
              }
              if ("dataSize" in f) {
                return { dataSize: f.dataSize };
              }
              return f;
            }),
          }
        );
        return accounts.map((acc) => ({
          pubkey: acc.pubkey.toBase58(),
          account: { data: acc.account.data },
        }));
      },
    },
    ctx.localnetConfig.programs.zVault
  );
}

/**
 * Get Merkle proof for a commitment from on-chain tree
 *
 * @param ctx - E2E test context
 * @param commitment - Commitment to get proof for
 * @returns OnChainMerkleProof or null if not found
 */
export async function getOnChainMerkleProof(
  ctx: E2ETestContext,
  commitment: bigint
): Promise<OnChainMerkleProof | null> {
  const tree = await fetchOnChainTree(ctx);
  return getMerkleProofFromTree(tree, commitment);
}

// =============================================================================
// Scanning and Claim Preparation
// =============================================================================

/**
 * Fetch stealth announcements from on-chain
 *
 * @param ctx - E2E test context
 * @returns Array of announcement data for scanning
 */
export async function fetchStealthAnnouncements(
  ctx: E2ETestContext
): Promise<Array<{
  ephemeralPub: Uint8Array;
  encryptedAmount: Uint8Array;
  commitment: Uint8Array;
  leafIndex: number;
}>> {
  const STEALTH_ANNOUNCEMENT_DISCRIMINATOR = 0x08;
  const STEALTH_ANNOUNCEMENT_SIZE = 90;

  const accounts = await ctx.connection.getProgramAccounts(
    new PublicKey(ctx.localnetConfig.programs.zVault),
    {
      filters: [
        { dataSize: STEALTH_ANNOUNCEMENT_SIZE },
      ],
    }
  );

  const announcements: Array<{
    ephemeralPub: Uint8Array;
    encryptedAmount: Uint8Array;
    commitment: Uint8Array;
    leafIndex: number;
  }> = [];

  for (const { account } of accounts) {
    const data = account.data;

    // Check discriminator
    if (data[0] !== STEALTH_ANNOUNCEMENT_DISCRIMINATOR) {
      continue;
    }

    // Parse data
    // Layout: disc(1) + bump(1) + ephemeral(32) + encrypted_amount(8) + commitment(32) + leaf_idx(8) + created_at(8)
    let offset = 2; // Skip disc + bump

    const ephemeralPub = new Uint8Array(data.slice(offset, offset + 32));
    offset += 32;

    const encryptedAmount = new Uint8Array(data.slice(offset, offset + 8));
    offset += 8;

    const commitment = new Uint8Array(data.slice(offset, offset + 32));
    offset += 32;

    // Parse leaf_index (u64 little-endian)
    const leafIndexView = new DataView(data.buffer, data.byteOffset + offset, 8);
    const leafIndex = Number(leafIndexView.getBigUint64(0, true));

    announcements.push({
      ephemeralPub,
      encryptedAmount,
      commitment,
      leafIndex,
    });
  }

  // Sort by leaf index
  announcements.sort((a, b) => a.leafIndex - b.leafIndex);

  return announcements;
}

/**
 * Scan announcements and prepare claim data for a recipient
 *
 * This performs the full flow:
 * 1. Fetch announcements from chain
 * 2. Scan with viewing key to find matching notes
 * 3. Fetch Merkle proof from on-chain tree
 * 4. Prepare claim inputs with spending key
 *
 * @param ctx - E2E test context
 * @param recipientKeys - Recipient's ZVault keys
 * @param expectedCommitment - Expected commitment to find (optional, for verification)
 * @returns PreparedClaimData ready for proof generation
 */
export async function scanAndPrepareClaim(
  ctx: E2ETestContext,
  recipientKeys: ZVaultKeys,
  expectedCommitment?: bigint
): Promise<PreparedClaimData> {
  // 1. Fetch announcements from chain
  console.log("[StealthHelper] Fetching stealth announcements...");
  const announcements = await fetchStealthAnnouncements(ctx);
  console.log(`[StealthHelper] Found ${announcements.length} announcements`);

  // 2. Scan with viewing key
  console.log("[StealthHelper] Scanning with viewing key...");
  const scannedNotes = await scanAnnouncements(recipientKeys, announcements);
  console.log(`[StealthHelper] Found ${scannedNotes.length} notes for recipient`);

  if (scannedNotes.length === 0) {
    throw new Error("No notes found for recipient");
  }

  // Find the matching note (or use the first one)
  let scannedNote: ScannedNote;
  if (expectedCommitment !== undefined) {
    const matching = scannedNotes.find(
      (n) => bytesToBigint(n.commitment) === expectedCommitment
    );
    if (!matching) {
      throw new Error(`Note with expected commitment not found`);
    }
    scannedNote = matching;
  } else {
    scannedNote = scannedNotes[0];
  }

  console.log(`[StealthHelper] Using note at leaf index: ${scannedNote.leafIndex}`);
  console.log(`[StealthHelper] Amount: ${scannedNote.amount} sats`);

  // 3. Fetch Merkle proof from on-chain tree
  console.log("[StealthHelper] Fetching Merkle proof...");
  const commitment = bytesToBigint(scannedNote.commitment);
  const merkleProof = await getOnChainMerkleProof(ctx, commitment);

  if (!merkleProof) {
    throw new Error("Failed to get Merkle proof for commitment");
  }

  console.log(`[StealthHelper] Merkle root: ${merkleProof.root.toString(16).slice(0, 16)}...`);

  // 4. Prepare claim inputs with spending key
  console.log("[StealthHelper] Preparing claim inputs...");
  const claimInputs = await prepareClaimInputs(recipientKeys, scannedNote, {
    root: merkleProof.root,
    pathElements: merkleProof.siblings,
    pathIndices: merkleProof.indices,
  });

  // Compute nullifier hash
  const nullifierHash = hashNullifierSync(claimInputs.nullifier);
  const nullifierHashBytes = bigintToBytes(nullifierHash, 32);

  console.log(`[StealthHelper] Nullifier hash: ${nullifierHash.toString(16).slice(0, 16)}...`);

  return {
    scannedNote,
    merkleProof,
    nullifierHash,
    nullifierHashBytes,
    stealthPrivKey: claimInputs.stealthPrivKey,
    stealthPubKeyX: scannedNote.stealthPub.x,
  };
}

// =============================================================================
// Verification Helpers
// =============================================================================

/**
 * Check if a nullifier PDA exists (note has been spent)
 *
 * @param ctx - E2E test context
 * @param nullifierHashBytes - Nullifier hash as bytes
 * @returns true if nullifier exists (note spent)
 */
export async function checkNullifierExists(
  ctx: E2ETestContext,
  nullifierHashBytes: Uint8Array
): Promise<boolean> {
  const { deriveNullifierRecordPDA } = await import("../../src/pda");
  const [nullifierPda] = await deriveNullifierRecordPDA(
    nullifierHashBytes,
    address(ctx.localnetConfig.programs.zVault)
  );

  const info = await ctx.connection.getAccountInfo(new PublicKey(nullifierPda.toString()));
  return info !== null;
}

/**
 * Get token balance for an address
 *
 * @param ctx - E2E test context
 * @param owner - Token account owner
 * @returns Token balance in raw units
 */
export async function getTokenBalance(
  ctx: E2ETestContext,
  owner: PublicKey
): Promise<bigint> {
  const zkbtcMint = new PublicKey(ctx.localnetConfig.accounts.zkbtcMint);

  try {
    const accounts = await ctx.connection.getTokenAccountsByOwner(owner, {
      mint: zkbtcMint,
    });

    if (accounts.value.length === 0) {
      return 0n;
    }

    // Parse token account data to get balance
    const data = accounts.value[0].account.data;
    // Token account layout: mint(32) + owner(32) + amount(8) + ...
    const amountOffset = 64;
    const amountView = new DataView(data.buffer, data.byteOffset + amountOffset, 8);
    return amountView.getBigUint64(0, true);
  } catch {
    return 0n;
  }
}
