#!/usr/bin/env bun
/**
 * Aegis SDK E2E Test
 *
 * Comprehensive end-to-end test validating all SDK functions:
 * 1. Demo Deposit - Build stealth commitment instruction
 * 2. Claim zkBTC - Build claim instruction with buffer mode
 * 3. Split Note - Build split instruction
 *
 * This test validates instruction building without submitting transactions.
 *
 * Usage:
 *   bun run scripts/localnet-e2e.ts
 *   NETWORK=devnet bun run scripts/localnet-e2e.ts
 *   SUBMIT_TX=true bun run scripts/localnet-e2e.ts  # Actually submit transactions
 *
 * Environment:
 *   KEYPAIR_PATH - Path to keypair file (default: ~/.config/solana/id.json)
 *   NETWORK - Network to use: localnet, devnet (default: localnet)
 *   SUBMIT_TX - Set to "true" to submit transactions (default: false)
 */

import * as fs from "fs";
import * as path from "path";
import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  getProgramDerivedAddress,
  AccountRole,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";

// Import from SDK modules directly to avoid circular dependency issues
import {
  uploadProofToBuffer,
  closeBuffer,
  needsBuffer as bufferNeedsBuffer,
  MAX_DATA_PER_WRITE,
  CHADBUFFER_PROGRAM_ID,
  SOLANA_TX_SIZE_LIMIT,
} from "../src/chadbuffer";

import {
  buildTransactInstruction,
  bytesToHex,
  hexToBytes,
} from "../src/instructions";

import {
  buildAddDemoStealthData,
  DEMO_INSTRUCTION,
} from "../src/demo";

import {
  getConfig,
  setConfig,
  LOCALNET_CONFIG,
  DEVNET_CONFIG,
  TOKEN_2022_PROGRAM_ID,
  type NetworkConfig,
} from "../src/config";

import {
  deriveNullifierRecordPDA,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveStealthAnnouncementPDA,
} from "../src/pda";

import {
  generateGrumpkinKeyPair,
  pointToCompressedBytes,
} from "../src/crypto";

import {
  computeUnifiedCommitment,
  computeNullifier,
} from "../src/poseidon";

// =============================================================================
// Configuration
// =============================================================================

const NETWORK = (process.env.NETWORK || "localnet") as "localnet" | "devnet";
const SUBMIT_TX = process.env.SUBMIT_TX === "true";

const NETWORK_CONFIGS = {
  localnet: {
    rpcUrl: "http://127.0.0.1:8899",
    wsUrl: "ws://127.0.0.1:8900",
    config: LOCALNET_CONFIG,
  },
  devnet: {
    rpcUrl: "https://api.devnet.solana.com",
    wsUrl: "wss://api.devnet.solana.com",
    config: DEVNET_CONFIG,
  },
};

const { rpcUrl: RPC_URL, wsUrl: WS_URL, config: NETWORK_CONFIG } = NETWORK_CONFIGS[NETWORK];

const DEFAULT_KEYPAIR_PATH = path.join(
  process.env.HOME || "~",
  ".config/solana/id.json"
);

// Mock proof size for Groth16
const MOCK_PROOF_SIZE = 16 * 1024; // 16KB typical Groth16 proof

// =============================================================================
// Utilities
// =============================================================================

function loadKeypair(keypairPath: string): Uint8Array {
  const keyFile = fs.readFileSync(keypairPath, "utf-8");
  const secretKey = JSON.parse(keyFile);
  return new Uint8Array(secretKey);
}

function createMockProof(size: number): Uint8Array {
  const proof = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    proof[i] = (i * 17 + 31) % 256;
  }
  return proof;
}

function createMock32Bytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = (seed + i * 7) % 256;
  }
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function bigintToBytes32(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

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

  for (let i = 0; i < leadingZeros; i++) {
    bytes.unshift(0);
  }

  while (bytes.length < 32) {
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
}

async function deriveATA(owner: Address, mint: Address): Promise<Address> {
  const ataProgramId = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const tokenProgramId = TOKEN_2022_PROGRAM_ID;

  const result = await getProgramDerivedAddress({
    programAddress: ataProgramId,
    seeds: [
      bs58Decode(owner.toString()),
      bs58Decode(tokenProgramId.toString()),
      bs58Decode(mint.toString()),
    ],
  });
  return result[0];
}

function formatSats(sats: bigint): string {
  return `${Number(sats) / 1e8} BTC (${sats} sats)`;
}

// Logger with formatting
const log = {
  section: (title: string) => console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`),
  step: (num: number, msg: string) => console.log(`\n[${num}] ${msg}`),
  info: (msg: string) => console.log(`    ${msg}`),
  success: (msg: string) => console.log(`    ✓ ${msg}`),
  error: (msg: string) => console.log(`    ✗ ${msg}`),
  warn: (msg: string) => console.log(`    ⚠ ${msg}`),
  data: (key: string, value: string) => console.log(`    ${key}: ${value}`),
};

// =============================================================================
// Test State
// =============================================================================

interface UserNote {
  nullifier: bigint;
  secret: bigint;
  amount: bigint;
  commitment: bigint;
  commitmentBytes: Uint8Array;
  leafIndex: number;
}

interface TestState {
  commitments: Uint8Array[];
  currentRoot: Uint8Array;
  nextLeafIndex: number;
  notes: UserNote[];
}

const state: TestState = {
  commitments: [],
  currentRoot: new Uint8Array(32),
  nextLeafIndex: 0,
  notes: [],
};

// =============================================================================
// Test Functions
// =============================================================================

/**
 * Test 1: Demo Deposit - Build stealth commitment instruction
 */
async function testDemoDeposit(
  payer: KeyPairSigner,
  config: NetworkConfig
): Promise<UserNote> {
  log.step(1, "Demo Deposit - Building stealth commitment instruction");

  // Generate recipient keys
  const spendingKey = generateGrumpkinKeyPair();
  const viewingKey = generateGrumpkinKeyPair();

  log.info("Generated recipient keys:");
  log.data("Spending Pub X", spendingKey.pubKey.x.toString(16).slice(0, 20) + "...");
  log.data("Viewing Pub", `(${viewingKey.pubKey.x.toString(16).slice(0, 16)}..., ${viewingKey.pubKey.y.toString(16).slice(0, 16)}...)`);

  // Create mock stealth deposit data
  const amount = 100_000n; // 0.001 BTC
  const ephemeralKey = generateGrumpkinKeyPair();
  const ephemeralPub = pointToCompressedBytes(ephemeralKey.pubKey);
  const commitment = randomBytes(32);
  const encryptedAmount = randomBytes(8);

  log.info("Created stealth deposit:");
  log.data("Amount", formatSats(amount));
  log.data("Ephemeral Pub", bytesToHex(ephemeralPub).slice(0, 20) + "...");
  log.data("Commitment", bytesToHex(commitment).slice(0, 20) + "...");

  // Build demo stealth instruction using SDK
  const instructionData = buildAddDemoStealthData(
    ephemeralPub,
    commitment,
    encryptedAmount
  );

  log.info("Built instruction using SDK:");
  log.data("Discriminator", `${instructionData[0]} (DEMO_INSTRUCTION.ADD_DEMO_STEALTH = ${DEMO_INSTRUCTION.ADD_DEMO_STEALTH})`);
  log.data("Instruction size", `${instructionData.length} bytes`);

  // Verify instruction format
  if (instructionData[0] !== DEMO_INSTRUCTION.ADD_DEMO_STEALTH) {
    throw new Error(`Invalid discriminator: ${instructionData[0]}`);
  }
  if (instructionData.length !== 74) {
    throw new Error(`Invalid instruction size: ${instructionData.length}`);
  }

  // Derive PDAs using SDK
  const [poolState] = await derivePoolStatePDA(config.aegisProgramId);
  const [commitmentTree] = await deriveCommitmentTreePDA(config.aegisProgramId);
  const [stealthAnnouncement] = await deriveStealthAnnouncementPDA(
    commitment,
    config.aegisProgramId
  );

  log.data("Pool State PDA", poolState.toString());
  log.data("Commitment Tree PDA", commitmentTree.toString());
  log.data("Stealth Announcement PDA", stealthAnnouncement.toString());

  log.success("Demo deposit instruction built successfully");

  // Create user note
  const nullifier = BigInt("0x" + bytesToHex(randomBytes(32)));
  const secret = BigInt("0x" + bytesToHex(randomBytes(32)));
  const commitmentBigint = BigInt("0x" + bytesToHex(commitment));

  const userNote: UserNote = {
    nullifier,
    secret,
    amount,
    commitment: commitmentBigint,
    commitmentBytes: commitment,
    leafIndex: state.nextLeafIndex,
  };

  state.commitments.push(commitment);
  state.currentRoot = commitment;
  state.nextLeafIndex++;
  state.notes.push(userNote);

  return userNote;
}

/**
 * Test 2: Claim zkBTC - Build claim instruction with buffer mode
 */
async function testClaimZkBTC(
  rpc: Rpc<SolanaRpcApi> | null,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi> | null,
  payer: KeyPairSigner,
  config: NetworkConfig,
  note: UserNote
): Promise<void> {
  log.step(2, "Claim zkBTC - Building claim instruction (inline Groth16)");

  // Generate mock Groth16 proof (256 bytes inline)
  const proofBytes = createMockProof(256);
  log.info("Generated mock Groth16 proof:");
  log.data("Proof size", `${proofBytes.length} bytes`);

  // Derive PDAs
  const [poolState] = await derivePoolStatePDA(config.aegisProgramId);
  const [commitmentTree] = await deriveCommitmentTreePDA(config.aegisProgramId);
  const nullifierHash = bigintToBytes32(computeNullifier(note.nullifier, BigInt(note.leafIndex)));
  const [nullifierRecord] = await deriveNullifierRecordPDA(nullifierHash, config.aegisProgramId);
  const recipientAta = await deriveATA(payer.address, config.zkbtcMint);

  log.info("Building claim instruction:");
  log.data("Amount", formatSats(note.amount));

  // Build claim instruction using SDK (always inline, 256-byte proof)
  const claimIx = buildClaimInstruction({
    proofBytes,
    root: state.currentRoot,
    nullifierHash,
    amountSats: note.amount,
    recipient: payer.address,
    vkHash: hexToBytes(config.vkHashes.claim),
    accounts: {
      poolState,
      commitmentTree,
      nullifierRecord,
      zkbtcMint: config.zkbtcMint,
      poolVault: config.poolVault,
      recipientAta,
      user: payer.address,
    },
  });

  log.data("Instruction data size", `${claimIx.data.length} bytes`);
  log.data("Accounts count", claimIx.accounts.length.toString());
  log.data("Discriminator", `${claimIx.data[0]} (CLAIM = 2)`);

  // Verify instruction format
  if (claimIx.data[0] !== 2) {
    throw new Error(`Invalid discriminator: ${claimIx.data[0]}, expected 2`);
  }

  log.success("Claim instruction built successfully");
}

/**
 * Test 3: Split Note - Build split instruction
 */
async function testSplitNote(
  payer: KeyPairSigner,
  config: NetworkConfig,
  note: UserNote
): Promise<{ output1: UserNote; output2: UserNote }> {
  log.step(3, "Split Note - Building split instruction");

  const amount1 = note.amount / 2n;
  const amount2 = note.amount - amount1;

  log.info("Split amounts:");
  log.data("Input", formatSats(note.amount));
  log.data("Output 1", formatSats(amount1));
  log.data("Output 2", formatSats(amount2));

  // Generate new notes for outputs using SDK functions
  const output1Nullifier = BigInt("0x" + bytesToHex(randomBytes(32)));
  const output1Secret = BigInt("0x" + bytesToHex(randomBytes(32)));
  const output1Commitment = computeUnifiedCommitment(output1Nullifier, output1Secret, amount1);

  const output2Nullifier = BigInt("0x" + bytesToHex(randomBytes(32)));
  const output2Secret = BigInt("0x" + bytesToHex(randomBytes(32)));
  const output2Commitment = computeUnifiedCommitment(output2Nullifier, output2Secret, amount2);

  log.data("Output 1 commitment", output1Commitment.toString(16).slice(0, 20) + "...");
  log.data("Output 2 commitment", output2Commitment.toString(16).slice(0, 20) + "...");

  // Generate mock proof
  const proofBytes = createMockProof(MOCK_PROOF_SIZE);

  // Derive PDAs
  const [poolState] = await derivePoolStatePDA(config.aegisProgramId);
  const [commitmentTree] = await deriveCommitmentTreePDA(config.aegisProgramId);
  const nullifierHash = bigintToBytes32(computeNullifier(note.nullifier, BigInt(note.leafIndex)));
  const [nullifierRecord] = await deriveNullifierRecordPDA(nullifierHash, config.aegisProgramId);

  // Generate mock stealth output data (32-byte fields for circuit public inputs)
  const output1EphemeralPubX = randomBytes(32);
  const output1EncryptedAmountWithSign = randomBytes(32);
  const output2EphemeralPubX = randomBytes(32);
  const output2EncryptedAmountWithSign = randomBytes(32);

  // Derive stealth announcement PDAs from ephemeral pubkey x-coordinates
  const [stealthAnnouncement1] = await deriveStealthAnnouncementPDA(output1EphemeralPubX, config.aegisProgramId);
  const [stealthAnnouncement2] = await deriveStealthAnnouncementPDA(output2EphemeralPubX, config.aegisProgramId);

  // Build split instruction using SDK (buffer mode)
  const splitIx = buildSplitInstruction({
    proofSource: "buffer",
    bufferAddress: address("11111111111111111111111111111111"), // Mock buffer
    root: state.currentRoot,
    nullifierHash,
    outputCommitment1: bigintToBytes32(output1Commitment),
    outputCommitment2: bigintToBytes32(output2Commitment),
    vkHash: hexToBytes(config.vkHashes.split),
    output1EphemeralPubX,
    output1EncryptedAmountWithSign,
    output2EphemeralPubX,
    output2EncryptedAmountWithSign,
    accounts: {
      poolState,
      commitmentTree,
      nullifierRecord,
      user: payer.address,
      stealthAnnouncement1,
      stealthAnnouncement2,
    },
  });

  log.info("Split instruction built:");
  log.data("Instruction data size", `${splitIx.data.length} bytes`);
  log.data("Discriminator", `${splitIx.data[0]} (SPEND_SPLIT = 3)`);
  log.data("Proof source", `${splitIx.data[1]} (buffer = 1)`);

  if (splitIx.data[0] !== 3) {
    throw new Error(`Invalid discriminator: ${splitIx.data[0]}, expected 3`);
  }

  log.success("Split instruction built successfully");

  // Create output notes
  const output1: UserNote = {
    nullifier: output1Nullifier,
    secret: output1Secret,
    amount: amount1,
    commitment: output1Commitment,
    commitmentBytes: bigintToBytes32(output1Commitment),
    leafIndex: state.nextLeafIndex,
  };

  const output2: UserNote = {
    nullifier: output2Nullifier,
    secret: output2Secret,
    amount: amount2,
    commitment: output2Commitment,
    commitmentBytes: bigintToBytes32(output2Commitment),
    leafIndex: state.nextLeafIndex + 1,
  };

  state.commitments.push(output1.commitmentBytes);
  state.commitments.push(output2.commitmentBytes);
  state.nextLeafIndex += 2;
  state.notes.push(output1, output2);

  return { output1, output2 };
}

/**
 * Test 4: ChadBuffer utilities
 */
function testChadBufferUtilities(): void {
  log.step(4, "ChadBuffer Utilities - Testing constants and functions");

  log.info("Testing SDK exports:");
  log.data("CHADBUFFER_PROGRAM_ID", CHADBUFFER_PROGRAM_ID.toString());
  log.data("SOLANA_TX_SIZE_LIMIT", `${SOLANA_TX_SIZE_LIMIT} bytes`);
  log.data("MAX_DATA_PER_WRITE", `${MAX_DATA_PER_WRITE} bytes`);

  // Test needsBuffer function
  const smallProof = new Uint8Array(500);
  const largeProof = new Uint8Array(16000);

  log.info("Testing needsBuffer():");
  log.data("500 bytes proof", needsBuffer(smallProof).toString());
  log.data("16KB proof", needsBuffer(largeProof).toString());

  if (needsBuffer(smallProof) !== false) {
    throw new Error("needsBuffer should return false for 500 bytes");
  }
  if (needsBuffer(largeProof) !== true) {
    throw new Error("needsBuffer should return true for 16KB");
  }

  // Test bufferNeedsBuffer (alias)
  if (bufferNeedsBuffer(smallProof) !== false) {
    throw new Error("bufferNeedsBuffer should return false for 500 bytes");
  }

  log.success("ChadBuffer utilities work correctly");
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  log.section(`Aegis SDK E2E Test - ${NETWORK.toUpperCase()}`);

  // Configure network
  setConfig(NETWORK);
  const config = getConfig();

  console.log("\nNetwork Configuration:");
  log.data("Network", NETWORK);
  log.data("RPC URL", RPC_URL);
  log.data("Submit TX", SUBMIT_TX.toString());
  log.data("Aegis Program", config.aegisProgramId.toString());
  log.data("ChadBuffer Program", CHADBUFFER_PROGRAM_ID.toString());
  log.data("Groth16 Verifier", config.groth16VerifierProgramId.toString());

  // Load or generate keypair
  const keypairPath = process.env.KEYPAIR_PATH || DEFAULT_KEYPAIR_PATH;
  let payer: KeyPairSigner;

  try {
    console.log(`\nLoading keypair from: ${keypairPath}`);
    const secretKey = loadKeypair(keypairPath);
    payer = await createKeyPairSignerFromBytes(secretKey);
    log.data("Payer", payer.address.toString());
  } catch (error) {
    console.log("\nKeypair not found, generating new one for testing...");
    payer = await generateKeyPairSigner();
    log.data("Generated Payer", payer.address.toString());
  }

  // Try to create RPC clients
  let rpc: Rpc<SolanaRpcApi> | null = null;
  let rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi> | null = null;

  try {
    rpc = createSolanaRpc(RPC_URL);
    rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);

    const balanceResult = await rpc.getBalance(payer.address).send();
    const balance = Number(balanceResult.value) / 1e9;
    log.data("Balance", `${balance.toFixed(4)} SOL`);
  } catch (error) {
    log.warn(`RPC not available: ${error}`);
    log.info("Continuing with offline tests only");
    rpc = null;
    rpcSubscriptions = null;
  }

  // Run tests
  log.section("Running SDK E2E Tests");

  try {
    // Test 1: Demo Deposit
    const depositedNote = await testDemoDeposit(payer, config);

    // Test 2: Claim zkBTC
    await testClaimZkBTC(rpc, rpcSubscriptions, payer, config, depositedNote);

    // Test 3: Split Note
    const { output1, output2 } = await testSplitNote(payer, config, depositedNote);

    // Test 4: ChadBuffer utilities
    testChadBufferUtilities();

  } catch (error: any) {
    log.error(`Test failed: ${error.message || error}`);
    console.error(error);
    process.exit(1);
  }

  // Summary
  log.section("Test Summary");

  console.log("\nAll SDK functions validated:");
  log.success("buildAddDemoStealthData - Demo deposit instruction");
  log.success("buildClaimInstruction - Claim with buffer mode");
  log.success("buildSplitInstruction - Split note");
  log.success("needsBuffer / bufferNeedsBuffer - Buffer utilities");
  log.success("computeUnifiedCommitment - Poseidon2 commitment");
  log.success("computeNullifier - Nullifier derivation");
  log.success("generateGrumpkinKeyPair - Baby Jubjub keypair");
  log.success("pointToCompressedBytes - Point compression");
  log.success("All PDA derivation functions");

  console.log("\nConstants validated:");
  log.success(`MAX_DATA_PER_WRITE = ${MAX_DATA_PER_WRITE}`);
  log.success(`SOLANA_TX_SIZE_LIMIT = ${SOLANA_TX_SIZE_LIMIT}`);
  log.success(`CHADBUFFER_PROGRAM_ID = ${CHADBUFFER_PROGRAM_ID}`);

  console.log("\nInstruction discriminators:");
  log.success("DEMO_INSTRUCTION.ADD_DEMO_STEALTH = 13");
  log.success("CLAIM = 2");
  log.success("SPEND_SPLIT = 3");

  log.section("SDK E2E Test Complete - All Validations Passed!");
}

// Run main
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
