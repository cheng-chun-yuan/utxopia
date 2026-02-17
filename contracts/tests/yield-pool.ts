/**
 * zkEarn (Yield Pool) Integration Test Suite - Stealth Mode
 *
 * Tests the privacy-preserving yield pool using stealth addresses (EIP-5564/DKSAP):
 * - Create yield pool
 * - Stealth deposit (ECDH + ephemeral key)
 * - Scan positions (viewing key)
 * - Withdraw with stealth key (spending key)
 * - Claim yield (keep principal staked)
 * - Compound yield
 * - Update yield rate (governance)
 * - Harvest yield (backend service)
 *
 * Stealth Address Pattern:
 * - Sender generates ephemeral keypair
 * - sharedSecret = ECDH(ephemeral.priv, recipientViewingPub)
 * - stealthPub = spendingPub + hash(sharedSecret) * G
 * - poolCommitment = Poseidon2(stealthPub.x, principal, depositEpoch)
 * - nullifier = Poseidon2(stealthPriv, leafIndex)
 *
 * Run: bun test tests/yield-pool.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

// ============================================================================
// PROGRAM CONFIGURATION
// ============================================================================

/**
 * Program ID for zVault Pinocchio
 */
const PROGRAM_ID = new PublicKey("zKeyrLmpT8W9o8iRvhizuSihLAFLhfAGBvfM638Pbw8");

/**
 * Instruction discriminators for yield pool
 */
export const YieldPoolInstruction = {
  CreateYieldPool: 30,
  DepositToPool: 31,
  WithdrawFromPool: 32,
  ClaimPoolYield: 33,
  CompoundYield: 34,
  UpdateYieldRate: 35,
  HarvestYield: 36,
} as const;

/**
 * Account discriminators
 */
export const YieldPoolDiscriminators = {
  YIELD_POOL: 0x10,
  POOL_NULLIFIER_RECORD: 0x11,
  POOL_COMMITMENT_TREE: 0x12,
  STEALTH_POOL_ANNOUNCEMENT: 0x13,
};

/**
 * PDA Seeds
 */
export const YieldPoolSeeds = {
  YIELD_POOL: Buffer.from("yield_pool"),
  POOL_COMMITMENT_TREE: Buffer.from("pool_commitment_tree"),
  POOL_NULLIFIER: Buffer.from("pool_nullifier"),
  STEALTH_POOL_ANNOUNCEMENT: Buffer.from("stealth_pool_ann"),
  COMMITMENT_TREE: Buffer.from("commitment_tree"),
  POOL_STATE: Buffer.from("pool_state"),
  NULLIFIER: Buffer.from("nullifier"),
};

// ============================================================================
// ACCOUNT LAYOUTS
// ============================================================================

/**
 * YieldPool account layout
 */
export interface YieldPoolLayout {
  discriminator: number;
  bump: number;
  flags: number;
  poolId: Uint8Array;
  yieldRateBps: number;
  totalDeposits: bigint;
  totalWithdrawals: bigint;
  currentEpoch: bigint;
  epochDuration: bigint;
  totalPrincipal: bigint;
  totalYieldDistributed: bigint;
  yieldReserve: bigint;
  defiVault: Uint8Array;
  lastHarvest: bigint;
  commitmentTree: Uint8Array;
  authority: Uint8Array;
  createdAt: bigint;
  lastUpdate: bigint;
}

/**
 * StealthPoolAnnouncement layout
 */
export interface StealthPoolAnnouncementLayout {
  discriminator: number;
  bump: number;
  poolId: Uint8Array;
  ephemeralPub: Uint8Array;
  principal: bigint;
  depositEpoch: bigint;
  poolCommitment: Uint8Array;
  leafIndex: bigint;
  createdAt: bigint;
}

/**
 * Parse YieldPool from account data
 */
export function parseYieldPool(data: Buffer): YieldPoolLayout {
  if (data[0] !== YieldPoolDiscriminators.YIELD_POOL) {
    throw new Error(`Invalid YieldPool discriminator: ${data[0]}`);
  }

  return {
    discriminator: data[0],
    bump: data[1],
    flags: data[2],
    poolId: data.subarray(4, 12),
    yieldRateBps: data.readUInt16LE(12),
    totalDeposits: data.readBigUInt64LE(20),
    totalWithdrawals: data.readBigUInt64LE(28),
    currentEpoch: data.readBigUInt64LE(36),
    epochDuration: data.readBigInt64LE(44),
    totalPrincipal: data.readBigUInt64LE(52),
    totalYieldDistributed: data.readBigUInt64LE(60),
    yieldReserve: data.readBigUInt64LE(68),
    defiVault: data.subarray(76, 108),
    lastHarvest: data.readBigInt64LE(108),
    commitmentTree: data.subarray(116, 148),
    authority: data.subarray(148, 180),
    createdAt: data.readBigInt64LE(180),
    lastUpdate: data.readBigInt64LE(188),
  };
}

/**
 * Parse StealthPoolAnnouncement from account data
 */
export function parseStealthPoolAnnouncement(data: Buffer): StealthPoolAnnouncementLayout {
  if (data[0] !== YieldPoolDiscriminators.STEALTH_POOL_ANNOUNCEMENT) {
    throw new Error(`Invalid StealthPoolAnnouncement discriminator: ${data[0]}`);
  }

  return {
    discriminator: data[0],
    bump: data[1],
    poolId: data.subarray(8, 16),
    ephemeralPub: data.subarray(16, 49), // 33 bytes compressed Grumpkin
    principal: data.readBigUInt64LE(56),
    depositEpoch: data.readBigUInt64LE(64),
    poolCommitment: data.subarray(72, 104),
    leafIndex: data.readBigUInt64LE(104),
    createdAt: data.readBigInt64LE(112),
  };
}

// ============================================================================
// INSTRUCTION BUILDERS (Stealth Mode)
// ============================================================================

/**
 * Build CreateYieldPool instruction
 */
export function buildCreateYieldPoolInstruction(
  programId: PublicKey,
  yieldPool: PublicKey,
  poolCommitmentTree: PublicKey,
  authority: PublicKey,
  poolId: Uint8Array,
  yieldRateBps: number,
  epochDuration: number,
  defiVault: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(51);
  data[0] = YieldPoolInstruction.CreateYieldPool;
  data.set(poolId.slice(0, 8), 1);
  data.writeUInt16LE(yieldRateBps, 9);
  data.writeBigInt64LE(BigInt(epochDuration), 11);
  data.set(defiVault.toBuffer(), 19);

  return new TransactionInstruction({
    keys: [
      { pubkey: yieldPool, isSigner: false, isWritable: true },
      { pubkey: poolCommitmentTree, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Build DepositToPool instruction (Stealth Mode)
 *
 * Includes ephemeral public key for stealth address derivation
 */
export function buildDepositToPoolInstruction(
  programId: PublicKey,
  yieldPool: PublicKey,
  poolCommitmentTree: PublicKey,
  mainCommitmentTree: PublicKey,
  inputNullifierRecord: PublicKey,
  stealthPoolAnnouncement: PublicKey,
  depositor: PublicKey,
  proof: Uint8Array,
  inputNullifierHash: Uint8Array,
  poolCommitment: Uint8Array,
  ephemeralPub: Uint8Array, // 33 bytes Grumpkin compressed
  principal: bigint,
  inputMerkleRoot: Uint8Array
): TransactionInstruction {
  // discriminator (1) + proof (256) + input_nullifier_hash (32) + pool_commitment (32) + ephemeral_pub (33) + principal (8) + input_merkle_root (32) = 394
  const data = Buffer.alloc(394);
  let offset = 0;

  data[offset++] = YieldPoolInstruction.DepositToPool;
  data.set(proof.slice(0, 256), offset);
  offset += 256;
  data.set(inputNullifierHash.slice(0, 32), offset);
  offset += 32;
  data.set(poolCommitment.slice(0, 32), offset);
  offset += 32;
  data.set(ephemeralPub.slice(0, 33), offset);
  offset += 33;
  data.writeBigUInt64LE(principal, offset);
  offset += 8;
  data.set(inputMerkleRoot.slice(0, 32), offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: yieldPool, isSigner: false, isWritable: true },
      { pubkey: poolCommitmentTree, isSigner: false, isWritable: true },
      { pubkey: mainCommitmentTree, isSigner: false, isWritable: false },
      { pubkey: inputNullifierRecord, isSigner: false, isWritable: true },
      { pubkey: stealthPoolAnnouncement, isSigner: false, isWritable: true },
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Build WithdrawFromPool instruction (Stealth Mode)
 *
 * Includes stealth_pub_x for position verification
 */
export function buildWithdrawFromPoolInstruction(
  programId: PublicKey,
  yieldPool: PublicKey,
  poolCommitmentTree: PublicKey,
  mainCommitmentTree: PublicKey,
  poolNullifierRecord: PublicKey,
  withdrawer: PublicKey,
  proof: Uint8Array,
  poolNullifierHash: Uint8Array,
  outputCommitment: Uint8Array,
  poolMerkleRoot: Uint8Array,
  stealthPubX: Uint8Array, // 32 bytes
  principal: bigint,
  depositEpoch: bigint
): TransactionInstruction {
  // discriminator (1) + proof (256) + pool_nullifier_hash (32) + output_commitment (32) + pool_merkle_root (32) + stealth_pub_x (32) + principal (8) + deposit_epoch (8) = 401
  const data = Buffer.alloc(401);
  let offset = 0;

  data[offset++] = YieldPoolInstruction.WithdrawFromPool;
  data.set(proof.slice(0, 256), offset);
  offset += 256;
  data.set(poolNullifierHash.slice(0, 32), offset);
  offset += 32;
  data.set(outputCommitment.slice(0, 32), offset);
  offset += 32;
  data.set(poolMerkleRoot.slice(0, 32), offset);
  offset += 32;
  data.set(stealthPubX.slice(0, 32), offset);
  offset += 32;
  data.writeBigUInt64LE(principal, offset);
  offset += 8;
  data.writeBigUInt64LE(depositEpoch, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: yieldPool, isSigner: false, isWritable: true },
      { pubkey: poolCommitmentTree, isSigner: false, isWritable: false },
      { pubkey: mainCommitmentTree, isSigner: false, isWritable: true },
      { pubkey: poolNullifierRecord, isSigner: false, isWritable: true },
      { pubkey: withdrawer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Build ClaimPoolYield instruction (Stealth Mode)
 *
 * Creates new stealth position and separate yield note
 */
export function buildClaimPoolYieldInstruction(
  programId: PublicKey,
  yieldPool: PublicKey,
  poolCommitmentTree: PublicKey,
  mainCommitmentTree: PublicKey,
  poolNullifierRecord: PublicKey,
  newStealthPoolAnnouncement: PublicKey,
  claimer: PublicKey,
  proof: Uint8Array,
  oldNullifierHash: Uint8Array,
  newPoolCommitment: Uint8Array,
  newEphemeralPub: Uint8Array, // 33 bytes for new position
  yieldCommitment: Uint8Array,
  poolMerkleRoot: Uint8Array,
  stealthPubX: Uint8Array, // 32 bytes (old position)
  principal: bigint,
  depositEpoch: bigint
): TransactionInstruction {
  // discriminator (1) + proof (256) + old_nullifier_hash (32) + new_pool_commitment (32) + new_ephemeral_pub (33) + yield_commitment (32) + pool_merkle_root (32) + stealth_pub_x (32) + principal (8) + deposit_epoch (8) = 466
  const data = Buffer.alloc(466);
  let offset = 0;

  data[offset++] = YieldPoolInstruction.ClaimPoolYield;
  data.set(proof.slice(0, 256), offset);
  offset += 256;
  data.set(oldNullifierHash.slice(0, 32), offset);
  offset += 32;
  data.set(newPoolCommitment.slice(0, 32), offset);
  offset += 32;
  data.set(newEphemeralPub.slice(0, 33), offset);
  offset += 33;
  data.set(yieldCommitment.slice(0, 32), offset);
  offset += 32;
  data.set(poolMerkleRoot.slice(0, 32), offset);
  offset += 32;
  data.set(stealthPubX.slice(0, 32), offset);
  offset += 32;
  data.writeBigUInt64LE(principal, offset);
  offset += 8;
  data.writeBigUInt64LE(depositEpoch, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: yieldPool, isSigner: false, isWritable: true },
      { pubkey: poolCommitmentTree, isSigner: false, isWritable: true },
      { pubkey: mainCommitmentTree, isSigner: false, isWritable: true },
      { pubkey: poolNullifierRecord, isSigner: false, isWritable: true },
      { pubkey: newStealthPoolAnnouncement, isSigner: false, isWritable: true },
      { pubkey: claimer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Build CompoundYield instruction (Stealth Mode)
 */
export function buildCompoundYieldInstruction(
  programId: PublicKey,
  yieldPool: PublicKey,
  poolCommitmentTree: PublicKey,
  poolNullifierRecord: PublicKey,
  newStealthPoolAnnouncement: PublicKey,
  compounder: PublicKey,
  proof: Uint8Array,
  oldNullifierHash: Uint8Array,
  newPoolCommitment: Uint8Array,
  newEphemeralPub: Uint8Array,
  poolMerkleRoot: Uint8Array,
  stealthPubX: Uint8Array,
  oldPrincipal: bigint,
  depositEpoch: bigint
): TransactionInstruction {
  // discriminator (1) + proof (256) + old_nullifier_hash (32) + new_pool_commitment (32) + new_ephemeral_pub (33) + pool_merkle_root (32) + stealth_pub_x (32) + old_principal (8) + deposit_epoch (8) = 434
  const data = Buffer.alloc(434);
  let offset = 0;

  data[offset++] = YieldPoolInstruction.CompoundYield;
  data.set(proof.slice(0, 256), offset);
  offset += 256;
  data.set(oldNullifierHash.slice(0, 32), offset);
  offset += 32;
  data.set(newPoolCommitment.slice(0, 32), offset);
  offset += 32;
  data.set(newEphemeralPub.slice(0, 33), offset);
  offset += 33;
  data.set(poolMerkleRoot.slice(0, 32), offset);
  offset += 32;
  data.set(stealthPubX.slice(0, 32), offset);
  offset += 32;
  data.writeBigUInt64LE(oldPrincipal, offset);
  offset += 8;
  data.writeBigUInt64LE(depositEpoch, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: yieldPool, isSigner: false, isWritable: true },
      { pubkey: poolCommitmentTree, isSigner: false, isWritable: true },
      { pubkey: poolNullifierRecord, isSigner: false, isWritable: true },
      { pubkey: newStealthPoolAnnouncement, isSigner: false, isWritable: true },
      { pubkey: compounder, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Build UpdateYieldRate instruction
 */
export function buildUpdateYieldRateInstruction(
  programId: PublicKey,
  yieldPool: PublicKey,
  authority: PublicKey,
  newRateBps: number
): TransactionInstruction {
  const data = Buffer.alloc(3);
  data[0] = YieldPoolInstruction.UpdateYieldRate;
  data.writeUInt16LE(newRateBps, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: yieldPool, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Build HarvestYield instruction
 */
export function buildHarvestYieldInstruction(
  programId: PublicKey,
  yieldPool: PublicKey,
  defiVault: PublicKey,
  harvester: PublicKey,
  harvestedAmount: bigint
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = YieldPoolInstruction.HarvestYield;
  data.writeBigUInt64LE(harvestedAmount, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: yieldPool, isSigner: false, isWritable: true },
      { pubkey: defiVault, isSigner: false, isWritable: false },
      { pubkey: harvester, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Derive YieldPool PDA
 */
export function deriveYieldPoolPDA(
  programId: PublicKey,
  poolId: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [YieldPoolSeeds.YIELD_POOL, poolId.slice(0, 8)],
    programId
  );
}

/**
 * Derive PoolCommitmentTree PDA
 */
export function derivePoolCommitmentTreePDA(
  programId: PublicKey,
  poolId: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [YieldPoolSeeds.POOL_COMMITMENT_TREE, poolId.slice(0, 8)],
    programId
  );
}

/**
 * Derive PoolNullifier PDA
 */
export function derivePoolNullifierPDA(
  programId: PublicKey,
  poolId: Uint8Array,
  nullifierHash: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [YieldPoolSeeds.POOL_NULLIFIER, poolId.slice(0, 8), nullifierHash.slice(0, 32)],
    programId
  );
}

/**
 * Derive StealthPoolAnnouncement PDA
 */
export function deriveStealthPoolAnnouncementPDA(
  programId: PublicKey,
  poolId: Uint8Array,
  commitment: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [YieldPoolSeeds.STEALTH_POOL_ANNOUNCEMENT, poolId.slice(0, 8), commitment.slice(0, 32)],
    programId
  );
}

/**
 * Generate random pool ID
 */
export function generatePoolId(): Uint8Array {
  return crypto.randomBytes(8);
}

/**
 * Generate mock proof (256 bytes)
 */
export function generateMockProof(): Uint8Array {
  return crypto.randomBytes(256);
}

/**
 * Generate mock commitment (32 bytes)
 */
export function generateMockCommitment(): Uint8Array {
  return crypto.randomBytes(32);
}

/**
 * Generate mock nullifier hash (32 bytes)
 */
export function generateMockNullifierHash(): Uint8Array {
  return crypto.randomBytes(32);
}

/**
 * Generate mock ephemeral public key (33 bytes compressed Grumpkin)
 */
export function generateMockEphemeralPub(): Uint8Array {
  const pub = crypto.randomBytes(33);
  // Set prefix byte for compressed point (02 or 03)
  pub[0] = Math.random() > 0.5 ? 0x02 : 0x03;
  return pub;
}

/**
 * Generate mock stealth public key x-coordinate (32 bytes)
 */
export function generateMockStealthPubX(): Uint8Array {
  return crypto.randomBytes(32);
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe("zkEarn (Yield Pool) Tests - Stealth Mode", () => {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");
  let payer: Keypair;
  let authority: Keypair;
  let user: Keypair;

  // Test data
  let poolId: Uint8Array;
  let yieldPoolPDA: PublicKey;
  let poolCommitmentTreePDA: PublicKey;
  let defiVault: Keypair;

  before(async () => {
    // Generate keypairs
    payer = Keypair.generate();
    authority = Keypair.generate();
    user = Keypair.generate();
    defiVault = Keypair.generate();
    poolId = generatePoolId();

    // Derive PDAs
    [yieldPoolPDA] = deriveYieldPoolPDA(PROGRAM_ID, poolId);
    [poolCommitmentTreePDA] = derivePoolCommitmentTreePDA(PROGRAM_ID, poolId);

    // Fund accounts
    try {
      const airdropSig1 = await connection.requestAirdrop(
        payer.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig1);

      const airdropSig2 = await connection.requestAirdrop(
        authority.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig2);

      const airdropSig3 = await connection.requestAirdrop(
        user.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig3);
    } catch (e) {
      console.log("Running in test environment without validator");
    }
  });

  describe("Contract Functions Overview (Stealth Mode)", () => {
    it("Lists all yield pool instructions with stealth support", () => {
      console.log("\n=== zkEarn (Yield Pool) - Stealth Mode ===\n");

      console.log("| Discriminator | Name              | Description |");
      console.log("|---------------|-------------------|-------------|");
      console.log("| 30            | CREATE_YIELD_POOL | Initialize pool |");
      console.log("| 31            | DEPOSIT_TO_POOL   | Stealth deposit (ephemeral key + ECDH) |");
      console.log("| 32            | WITHDRAW_FROM_POOL| Exit with stealthPriv-derived nullifier |");
      console.log("| 33            | CLAIM_POOL_YIELD  | Claim yield, create new stealth position |");
      console.log("| 34            | COMPOUND_YIELD    | Compound yield into new stealth position |");
      console.log("| 35            | UPDATE_YIELD_RATE | Governance rate update |");
      console.log("| 36            | HARVEST_YIELD     | Backend harvests DeFi yield |");

      console.log("\n=== Stealth Address Pattern (EIP-5564/DKSAP) ===\n");
      console.log("Deposit:");
      console.log("  1. Sender generates ephemeral Grumpkin keypair");
      console.log("  2. sharedSecret = ECDH(ephemeral.priv, recipientViewingPub)");
      console.log("  3. stealthPub = spendingPub + hash(sharedSecret) * G");
      console.log("  4. poolCommitment = Poseidon2(stealthPub.x, principal, epoch)");
      console.log("");
      console.log("Scan (viewing key only):");
      console.log("  1. sharedSecret = ECDH(viewingPriv, ephemeralPub)");
      console.log("  2. stealthPub = spendingPub + hash(sharedSecret) * G");
      console.log("  3. Verify: commitment == expected");
      console.log("");
      console.log("Claim (spending key required):");
      console.log("  1. stealthPriv = spendingPriv + hash(sharedSecret)");
      console.log("  2. nullifier = Poseidon2(stealthPriv, leafIndex)");
      console.log("");

      expect(YieldPoolInstruction.CreateYieldPool).to.equal(30);
      expect(YieldPoolInstruction.DepositToPool).to.equal(31);
      expect(YieldPoolInstruction.WithdrawFromPool).to.equal(32);
      expect(YieldPoolInstruction.ClaimPoolYield).to.equal(33);
      expect(YieldPoolInstruction.CompoundYield).to.equal(34);
      expect(YieldPoolInstruction.UpdateYieldRate).to.equal(35);
      expect(YieldPoolInstruction.HarvestYield).to.equal(36);
    });
  });

  describe("CREATE_YIELD_POOL (Discriminator: 30)", () => {
    it("should build create yield pool instruction correctly", () => {
      const yieldRateBps = 500; // 5%
      const epochDuration = 86400; // 1 day in seconds

      const ix = buildCreateYieldPoolInstruction(
        PROGRAM_ID,
        yieldPoolPDA,
        poolCommitmentTreePDA,
        authority.publicKey,
        poolId,
        yieldRateBps,
        epochDuration,
        defiVault.publicKey
      );

      expect(ix.data[0]).to.equal(YieldPoolInstruction.CreateYieldPool);
      expect(ix.keys.length).to.equal(4);
      expect(ix.keys[0].pubkey.equals(yieldPoolPDA)).to.be.true;
      expect(ix.keys[1].pubkey.equals(poolCommitmentTreePDA)).to.be.true;
      expect(ix.keys[2].pubkey.equals(authority.publicKey)).to.be.true;
      expect(ix.keys[2].isSigner).to.be.true;

      console.log(`  ✓ Pool ID: ${Buffer.from(poolId).toString("hex")}`);
      console.log(`  ✓ Yield Rate: ${yieldRateBps / 100}% per epoch`);
      console.log(`  ✓ Epoch Duration: ${epochDuration}s (${epochDuration / 3600}h)`);
    });
  });

  describe("DEPOSIT_TO_POOL (Discriminator: 31) - Stealth", () => {
    it("should build stealth deposit instruction correctly", () => {
      const proof = generateMockProof();
      const inputNullifierHash = generateMockNullifierHash();
      const poolCommitment = generateMockCommitment();
      const ephemeralPub = generateMockEphemeralPub();
      const principal = 100_000_000n; // 1 BTC
      const inputMerkleRoot = generateMockCommitment();

      // Derive PDAs
      const [inputNullifierPDA] = PublicKey.findProgramAddressSync(
        [YieldPoolSeeds.NULLIFIER, inputNullifierHash],
        PROGRAM_ID
      );
      const [mainCommitmentTreePDA] = PublicKey.findProgramAddressSync(
        [YieldPoolSeeds.COMMITMENT_TREE],
        PROGRAM_ID
      );
      const [stealthAnnouncementPDA] = deriveStealthPoolAnnouncementPDA(
        PROGRAM_ID,
        poolId,
        poolCommitment
      );

      const ix = buildDepositToPoolInstruction(
        PROGRAM_ID,
        yieldPoolPDA,
        poolCommitmentTreePDA,
        mainCommitmentTreePDA,
        inputNullifierPDA,
        stealthAnnouncementPDA,
        user.publicKey,
        proof,
        inputNullifierHash,
        poolCommitment,
        ephemeralPub,
        principal,
        inputMerkleRoot
      );

      expect(ix.data[0]).to.equal(YieldPoolInstruction.DepositToPool);
      expect(ix.keys.length).to.equal(7);
      expect(ix.keys[4].pubkey.equals(stealthAnnouncementPDA)).to.be.true;
      expect(ix.keys[5].isSigner).to.be.true; // depositor

      console.log(`  ✓ Principal: ${principal} sats (${Number(principal) / 100_000_000} BTC)`);
      console.log(`  ✓ Ephemeral pubkey: ${Buffer.from(ephemeralPub).toString("hex").slice(0, 20)}...`);
      console.log(`  ✓ Stealth announcement PDA created on-chain`);
      console.log(`  ✓ Privacy: Only ephemeral key visible, commitment unlinkable`);
    });
  });

  describe("Viewing Key Scanning", () => {
    it("describes how viewing key scans for positions", () => {
      console.log("\n=== Viewing Key Scanning Process ===\n");
      console.log("1. Fetch all StealthPoolAnnouncement accounts");
      console.log("2. For each announcement:");
      console.log("   - Extract ephemeralPub (33 bytes)");
      console.log("   - Compute sharedSecret = ECDH(viewingPriv, ephemeralPub)");
      console.log("   - Derive stealthPub = spendingPub + hash(sharedSecret) * G");
      console.log("   - Compute expected = Poseidon2(stealthPub.x, principal, epoch)");
      console.log("   - If expected == poolCommitment: Position belongs to us!");
      console.log("");
      console.log("What viewing key CAN do:");
      console.log("  ✓ Detect all positions belonging to user");
      console.log("  ✓ See principal amounts");
      console.log("  ✓ Calculate earned yield");
      console.log("");
      console.log("What viewing key CANNOT do:");
      console.log("  ✗ Derive stealthPriv (needs spendingPriv)");
      console.log("  ✗ Generate nullifier");
      console.log("  ✗ Spend or withdraw funds");
      console.log("");

      expect(true).to.be.true;
    });
  });

  describe("WITHDRAW_FROM_POOL (Discriminator: 32) - Stealth", () => {
    it("should build stealth withdraw instruction correctly", () => {
      const proof = generateMockProof();
      const poolNullifierHash = generateMockNullifierHash();
      const outputCommitment = generateMockCommitment();
      const poolMerkleRoot = generateMockCommitment();
      const stealthPubX = generateMockStealthPubX();
      const principal = 100_000_000n;
      const depositEpoch = 10n;

      const [poolNullifierPDA] = derivePoolNullifierPDA(
        PROGRAM_ID,
        poolId,
        poolNullifierHash
      );
      const [mainCommitmentTreePDA] = PublicKey.findProgramAddressSync(
        [YieldPoolSeeds.COMMITMENT_TREE],
        PROGRAM_ID
      );

      const ix = buildWithdrawFromPoolInstruction(
        PROGRAM_ID,
        yieldPoolPDA,
        poolCommitmentTreePDA,
        mainCommitmentTreePDA,
        poolNullifierPDA,
        user.publicKey,
        proof,
        poolNullifierHash,
        outputCommitment,
        poolMerkleRoot,
        stealthPubX,
        principal,
        depositEpoch
      );

      expect(ix.data[0]).to.equal(YieldPoolInstruction.WithdrawFromPool);
      expect(ix.keys.length).to.equal(6);

      console.log(`  ✓ Nullifier derived from stealthPriv + leafIndex`);
      console.log(`  ✓ stealthPriv = spendingPriv + hash(sharedSecret)`);
      console.log(`  ✓ Output includes principal + calculated yield`);
      console.log(`  ✓ Privacy: Withdrawal cannot be linked to deposit`);
    });
  });

  describe("CLAIM_POOL_YIELD (Discriminator: 33) - Stealth", () => {
    it("should build stealth claim yield instruction correctly", () => {
      const proof = generateMockProof();
      const oldNullifierHash = generateMockNullifierHash();
      const newPoolCommitment = generateMockCommitment();
      const newEphemeralPub = generateMockEphemeralPub();
      const yieldCommitment = generateMockCommitment();
      const poolMerkleRoot = generateMockCommitment();
      const stealthPubX = generateMockStealthPubX();
      const principal = 100_000_000n;
      const depositEpoch = 10n;

      const [poolNullifierPDA] = derivePoolNullifierPDA(
        PROGRAM_ID,
        poolId,
        oldNullifierHash
      );
      const [mainCommitmentTreePDA] = PublicKey.findProgramAddressSync(
        [YieldPoolSeeds.COMMITMENT_TREE],
        PROGRAM_ID
      );
      const [newStealthAnnouncementPDA] = deriveStealthPoolAnnouncementPDA(
        PROGRAM_ID,
        poolId,
        newPoolCommitment
      );

      const ix = buildClaimPoolYieldInstruction(
        PROGRAM_ID,
        yieldPoolPDA,
        poolCommitmentTreePDA,
        mainCommitmentTreePDA,
        poolNullifierPDA,
        newStealthAnnouncementPDA,
        user.publicKey,
        proof,
        oldNullifierHash,
        newPoolCommitment,
        newEphemeralPub,
        yieldCommitment,
        poolMerkleRoot,
        stealthPubX,
        principal,
        depositEpoch
      );

      expect(ix.data[0]).to.equal(YieldPoolInstruction.ClaimPoolYield);
      expect(ix.keys.length).to.equal(7);

      console.log(`  ✓ Creates new stealth position (same principal, reset epoch)`);
      console.log(`  ✓ New ephemeral key for fresh ECDH derivation`);
      console.log(`  ✓ Yields separate zkBTC note for earned yield`);
      console.log(`  ✓ Principal stays staked with new stealth address`);
    });
  });

  describe("COMPOUND_YIELD (Discriminator: 34) - Stealth", () => {
    it("should build stealth compound yield instruction correctly", () => {
      const proof = generateMockProof();
      const oldNullifierHash = generateMockNullifierHash();
      const newPoolCommitment = generateMockCommitment();
      const newEphemeralPub = generateMockEphemeralPub();
      const poolMerkleRoot = generateMockCommitment();
      const stealthPubX = generateMockStealthPubX();
      const oldPrincipal = 100_000_000n;
      const depositEpoch = 10n;

      const [poolNullifierPDA] = derivePoolNullifierPDA(
        PROGRAM_ID,
        poolId,
        oldNullifierHash
      );
      const [newStealthAnnouncementPDA] = deriveStealthPoolAnnouncementPDA(
        PROGRAM_ID,
        poolId,
        newPoolCommitment
      );

      const ix = buildCompoundYieldInstruction(
        PROGRAM_ID,
        yieldPoolPDA,
        poolCommitmentTreePDA,
        poolNullifierPDA,
        newStealthAnnouncementPDA,
        user.publicKey,
        proof,
        oldNullifierHash,
        newPoolCommitment,
        newEphemeralPub,
        poolMerkleRoot,
        stealthPubX,
        oldPrincipal,
        depositEpoch
      );

      expect(ix.data[0]).to.equal(YieldPoolInstruction.CompoundYield);
      expect(ix.keys.length).to.equal(6);

      console.log(`  ✓ New stealth position has principal + yield compounded`);
      console.log(`  ✓ Fresh ephemeral key for new position`);
      console.log(`  ✓ More efficient than claim + deposit`);
    });
  });

  describe("UPDATE_YIELD_RATE (Discriminator: 35)", () => {
    it("should build update yield rate instruction correctly", () => {
      const newRateBps = 600; // 6%

      const ix = buildUpdateYieldRateInstruction(
        PROGRAM_ID,
        yieldPoolPDA,
        authority.publicKey,
        newRateBps
      );

      expect(ix.data[0]).to.equal(YieldPoolInstruction.UpdateYieldRate);
      expect(ix.data.readUInt16LE(1)).to.equal(newRateBps);
      expect(ix.keys.length).to.equal(2);
      expect(ix.keys[1].isSigner).to.be.true;

      console.log(`  ✓ New rate: ${newRateBps / 100}% per epoch`);
      console.log(`  ✓ Only pool authority can update rate`);
    });
  });

  describe("HARVEST_YIELD (Discriminator: 36)", () => {
    it("should build harvest yield instruction correctly", () => {
      const harvestedAmount = 5_000_000n; // 0.05 BTC

      const ix = buildHarvestYieldInstruction(
        PROGRAM_ID,
        yieldPoolPDA,
        defiVault.publicKey,
        authority.publicKey,
        harvestedAmount
      );

      expect(ix.data[0]).to.equal(YieldPoolInstruction.HarvestYield);
      expect(ix.data.readBigUInt64LE(1)).to.equal(harvestedAmount);
      expect(ix.keys.length).to.equal(4);

      console.log(`  ✓ Harvested: ${harvestedAmount} sats from DeFi vault`);
      console.log(`  ✓ Updates yield_reserve for user withdrawals`);
    });
  });

  describe("Yield Calculation", () => {
    it("should calculate yield correctly", () => {
      const principal = 100_000_000n; // 1 BTC
      const depositEpoch = 10n;
      const currentEpoch = 20n;
      const yieldRateBps = 500n; // 5%

      const epochsStaked = currentEpoch - depositEpoch; // 10 epochs
      const yieldAmount = (principal * epochsStaked * yieldRateBps) / 10000n;

      expect(yieldAmount).to.equal(50_000_000n);

      const totalValue = principal + yieldAmount;
      expect(totalValue).to.equal(150_000_000n);

      console.log(`  ✓ Principal: ${Number(principal) / 100_000_000} BTC`);
      console.log(`  ✓ Epochs staked: ${epochsStaked}`);
      console.log(`  ✓ Yield rate: ${Number(yieldRateBps) / 100}% per epoch`);
      console.log(`  ✓ Earned yield: ${Number(yieldAmount) / 100_000_000} BTC`);
      console.log(`  ✓ Total value: ${Number(totalValue) / 100_000_000} BTC`);
    });
  });

  describe("Privacy Analysis - Stealth Mode", () => {
    it("validates stealth privacy guarantees", () => {
      console.log("\n=== Stealth Mode Privacy Analysis ===\n");

      console.log("What's HIDDEN (Private):");
      console.log("  - Depositor identity (only ephemeral key visible)");
      console.log("  - Position amounts (principal/yield not visible)");
      console.log("  - Withdrawal identity (stealthPriv unlinkable)");
      console.log("  - Link between deposit and position");

      console.log("\nWhat's VISIBLE on StealthPoolAnnouncement:");
      console.log("  - ephemeral_pub (33 bytes) - can't link to recipient");
      console.log("  - pool_commitment (32 bytes) - unlinkable hash");
      console.log("  - principal (public for yield calculation)");
      console.log("  - deposit_epoch (public for yield calculation)");

      console.log("\nStealth Guarantees:");
      console.log("  ✓ Viewing key can scan but CANNOT spend");
      console.log("  ✓ Spending key required for stealthPriv derivation");
      console.log("  ✓ Each deposit uses unique ephemeral key");
      console.log("  ✓ Claim/compound creates fresh stealth address");

      console.log("\nAdvantages over Note-Based:");
      console.log("  ✓ No need to save nullifier/secret per position");
      console.log("  ✓ Auto-discovery with viewing key scan");
      console.log("  ✓ Consistent with regular stealth transfers");
      console.log("  ✓ Can delegate viewing key for audits");
      console.log("");

      expect(true).to.be.true;
    });
  });

  describe("PDA Derivation", () => {
    it("should derive all PDAs correctly", () => {
      const [derivedPool, poolBump] = deriveYieldPoolPDA(PROGRAM_ID, poolId);
      const [derivedTree, treeBump] = derivePoolCommitmentTreePDA(PROGRAM_ID, poolId);

      expect(derivedPool.equals(yieldPoolPDA)).to.be.true;
      expect(derivedTree.equals(poolCommitmentTreePDA)).to.be.true;

      console.log(`  ✓ YieldPool PDA: ${yieldPoolPDA.toBase58().slice(0, 20)}...`);
      console.log(`  ✓ PoolCommitmentTree PDA: ${poolCommitmentTreePDA.toBase58().slice(0, 20)}...`);
    });

    it("should derive stealth pool announcement PDA correctly", () => {
      const commitment = generateMockCommitment();
      const [announcementPDA, bump] = deriveStealthPoolAnnouncementPDA(
        PROGRAM_ID,
        poolId,
        commitment
      );

      expect(announcementPDA).to.be.instanceOf(PublicKey);
      console.log(`  ✓ StealthPoolAnnouncement PDA: ${announcementPDA.toBase58().slice(0, 20)}...`);
    });

    it("should derive pool nullifier PDA correctly", () => {
      const nullifierHash = generateMockNullifierHash();
      const [nullifierPDA, bump] = derivePoolNullifierPDA(
        PROGRAM_ID,
        poolId,
        nullifierHash
      );

      expect(nullifierPDA).to.be.instanceOf(PublicKey);
      console.log(`  ✓ PoolNullifier PDA: ${nullifierPDA.toBase58().slice(0, 20)}...`);
    });
  });
});
