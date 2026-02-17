/**
 * ZVault Simplified API
 *
 * Organized into categories:
 *
 * DEPOSIT (BTC → zkBTC):
 * - deposit: Generate deposit credentials (taproot address + claim link)
 * - claimNote: Claim zkBTC tokens with ZK proof
 * - claimPublic: Claim zkBTC to public wallet (reveals amount)
 * - claimPublicStealth: Claim stealth note to public wallet
 *
 * TRANSFER (zkBTC → Someone):
 * - splitNote: Split one note into two outputs
 *
 * WITHDRAW (zkBTC → BTC):
 * - withdraw: Request BTC withdrawal (burn zkBTC)
 *
 * @module api
 */

import {
  address,
  getProgramDerivedAddress,
  AccountRole,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  compileTransaction,
  getBase64EncodedWireTransaction,
  type Address,
  type Blockhash,
} from "@solana/kit";

/** Instruction type for v2 */
interface Instruction {
  programAddress: Address;
  accounts: Array<{ address: Address; role: (typeof AccountRole)[keyof typeof AccountRole] }>;
  data: Uint8Array;
}
import { generateNote, computeNoteCommitment, type Note, formatBtc } from "./note";
import { getConfig, TOKEN_2022_PROGRAM_ID, ATA_PROGRAM_ID } from "./config";
import { deriveTaprootAddress } from "./taproot";
import { createClaimLink, parseClaimLink } from "./claim-link";
import {
  generateClaimProof as _generateClaimProof,
  generateSpendSplitProof as _generateSpendSplitProof,
  generateSpendPartialPublicProof as _generateSpendPartialPublicProof,
  type ProofData,
  type ClaimInputs,
  type SpendSplitInputs,
  type SpendPartialPublicInputs,
} from "./prover/web";

// Type alias for backward compatibility
type NoirProof = ProofData;
import {
  createStealthDeposit,
  prepareClaimInputs,
  type ScannedNote,
} from "./stealth";
import { type StealthMetaAddress, type ZVaultKeys } from "./keys";
import { type MerkleProof, TREE_DEPTH, ZERO_VALUE } from "./merkle";
import { bigintToBytes, bytesToBigint, hexToBytes, BN254_FIELD_PRIME } from "./crypto";
import { hashNullifierSync, computeNullifierSync } from "./poseidon";


/**
 * Generate claim proof from Note
 *
 * Converts Note-based input to the prover's ClaimInputs format.
 */
async function generateClaimProof(
  note: Note,
  merkleProof: MerkleProof,
  recipient: bigint
): Promise<NoirProof> {
  // privKey is used as spending key; pubKeyX is derived in-circuit via BabyPbk()
  const privKey = note.nullifier;

  const inputs: ClaimInputs = {
    privKey,
    amount: note.amount,
    leafIndex: BigInt(merkleProof.leafIndex),
    merkleRoot: bytesToBigint(merkleProof.root),
    merkleProof: {
      siblings: merkleProof.pathElements.map(el => bytesToBigint(el)),
      indices: merkleProof.pathIndices,
    },
    recipient,
  };

  return _generateClaimProof(inputs);
}

/**
 * Adapter: Generate split proof from Notes (legacy API)
 */
async function generateSplitProof(
  inputNote: Note,
  output1: Note,
  output2: Note,
  merkleProof: MerkleProof
): Promise<NoirProof> {
  // All public keys are derived in-circuit from private keys via BabyPbk()
  const privKey = inputNote.nullifier;

  const inputs: SpendSplitInputs = {
    privKey,
    amount: inputNote.amount,
    leafIndex: BigInt(merkleProof.leafIndex),
    merkleRoot: bytesToBigint(merkleProof.root),
    merkleProof: {
      siblings: merkleProof.pathElements.map(el => bytesToBigint(el)),
      indices: merkleProof.pathIndices,
    },
    output1PrivKey: output1.nullifier,
    output1Amount: output1.amount,
    output2PrivKey: output2.nullifier,
    output2Amount: output2.amount,
  };

  return _generateSpendSplitProof(inputs);
}

/**
 * Adapter: Generate partial withdraw proof from Note (legacy API)
 */
async function generatePartialWithdrawProof(
  inputNote: Note,
  publicAmount: bigint,
  changeNote: Note,
  merkleProof: MerkleProof,
  _recipient: Uint8Array // recipient is bound via public inputs
): Promise<NoirProof> {
  // All public keys are derived in-circuit from private keys via BabyPbk()
  const privKey = inputNote.nullifier;

  // Recipient as bigint (first 32 bytes interpreted as field element, reduced mod BN254 prime)
  const recipientBigint = bytesToBigint(_recipient) % BN254_FIELD_PRIME;

  const inputs: SpendPartialPublicInputs = {
    privKey,
    amount: inputNote.amount,
    leafIndex: BigInt(merkleProof.leafIndex),
    merkleRoot: bytesToBigint(merkleProof.root),
    merkleProof: {
      siblings: merkleProof.pathElements.map(el => bytesToBigint(el)),
      indices: merkleProof.pathIndices,
    },
    publicAmount,
    changePrivKey: changeNote.nullifier,
    changeAmount: changeNote.amount,
    recipient: recipientBigint,
  };

  return _generateSpendPartialPublicProof(inputs);
}

/** System program address */
const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");

// ============================================================================
// Types
// ============================================================================

/**
 * Result from deposit() - credentials needed to receive BTC
 */
export interface DepositResult {
  /** Note containing secrets (save this!) */
  note: Note;
  /** Bitcoin address to send BTC to */
  taprootAddress: string;
  /** Shareable claim link (contains secrets) */
  claimLink: string;
  /** Human-readable amount */
  displayAmount: string;
}

/**
 * Result from withdraw()
 */
export interface WithdrawResult {
  /** Transaction signature */
  signature: string;
  /** Amount being withdrawn in satoshis */
  withdrawAmount: bigint;
  /** Change note (if partial withdraw) */
  changeNote?: Note;
  /** Change claim link (if partial withdraw) */
  changeClaimLink?: string;
}

/**
 * Result from claimNote()
 */
export interface ClaimResult {
  /** Transaction signature */
  signature: string;
  /** Amount claimed in satoshis */
  amount: bigint;
  /** Recipient address */
  recipient: Address;
}

/**
 * Result from claimPublic()
 */
export interface ClaimPublicResult {
  /** Transaction signature */
  signature: string;
  /** Amount claimed in satoshis */
  amount: bigint;
  /** Recipient wallet address */
  recipient: Address;
  /** Recipient's token account address */
  recipientAta: Address;
}

/**
 * Result from claimPublicStealth()
 */
export interface ClaimPublicStealthResult {
  /** Transaction signature */
  signature: string;
  /** Amount claimed in satoshis */
  amount: bigint;
  /** Recipient wallet address */
  recipient: Address;
  /** Recipient's token account address */
  recipientAta: Address;
  /** Nullifier hash (for verification) */
  nullifierHash: Uint8Array;
}

/**
 * Result from splitNote()
 */
export interface SplitResult {
  /** Transaction signature */
  signature: string;
  /** First output note */
  output1: Note;
  /** Second output note */
  output2: Note;
  /** Nullifier hash of spent input */
  inputNullifierHash: Uint8Array;
}

/**
 * Signer interface for v2 transactions
 */
export interface TransactionSigner {
  address: Address;
  signTransaction: <T extends { signatures: Record<string, Uint8Array> }>(transaction: T) => Promise<T>;
}

/**
 * RPC interface for sending transactions
 */
export interface RpcClient {
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  sendTransaction: (transaction: Uint8Array) => Promise<string>;
  confirmTransaction: (signature: string) => Promise<void>;
  /** Optional: simulate transaction before sending (recommended for production) */
  simulateTransaction?: (transaction: Uint8Array) => Promise<{ err: unknown | null; logs?: string[] }>;
}

/**
 * Client configuration
 */
export interface ApiClientConfig {
  rpc: RpcClient;
  programId: Address;
  payer?: TransactionSigner;
}

// ============================================================================
// Constants
// ============================================================================

/** Default program ID (Solana Devnet) - imported from pda.ts */
export { ZVAULT_PROGRAM_ID as DEFAULT_PROGRAM_ID } from "./pda";

/** Instruction discriminators (must match contracts/programs/zvault/src/lib.rs) */
const INSTRUCTION = {
  VERIFY_STEALTH_DEPOSIT: 1,
  CLAIM: 2,
  SPEND_SPLIT: 3,
  SPEND_PARTIAL_PUBLIC: 4,
  REQUEST_REDEMPTION: 5,
} as const;

// ============================================================================
// PDA Derivation Helpers
// ============================================================================

async function derivePoolStatePDA(programId: Address): Promise<[Address, number]> {
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode("pool_state")],
  });
  return [result[0], result[1]];
}

async function deriveCommitmentTreePDA(programId: Address): Promise<[Address, number]> {
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode("commitment_tree")],
  });
  return [result[0], result[1]];
}

// ============================================================================
// Transaction Helper
// ============================================================================

/**
 * Send an instruction and confirm (v2 pattern)
 *
 * If RPC client supports simulation, simulates first to catch errors early.
 */
async function sendInstruction(
  config: ApiClientConfig,
  instruction: Instruction
): Promise<string> {
  if (!config.payer) {
    throw new Error("Payer required");
  }

  const blockhash = await config.rpc.getLatestBlockhash();

  // Build transaction message
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(config.payer!.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash.blockhash as Blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      msg
    ),
    (msg) => appendTransactionMessageInstruction(instruction as any, msg)
  );

  // Compile and sign
  const compiledTx = compileTransaction(message);
  const signedTx = await config.payer.signTransaction(compiledTx as any);

  // Get transaction bytes
  const txBytes = getBase64EncodedWireTransaction(signedTx as any);
  const txBytesEncoded = new TextEncoder().encode(txBytes);

  // Simulate transaction before sending (if supported)
  if (config.rpc.simulateTransaction) {
    const simResult = await config.rpc.simulateTransaction(txBytesEncoded);
    if (simResult.err) {
      const errorMsg = typeof simResult.err === "string"
        ? simResult.err
        : JSON.stringify(simResult.err);
      const logs = simResult.logs?.join("\n") ?? "";
      throw new Error(
        `Transaction simulation failed: ${errorMsg}${logs ? `\nLogs:\n${logs}` : ""}`
      );
    }
  }

  // Send transaction
  const signature = await config.rpc.sendTransaction(txBytesEncoded);
  await config.rpc.confirmTransaction(signature);

  return signature;
}

async function deriveNullifierRecordPDA(
  programId: Address,
  nullifierHash: Uint8Array
): Promise<[Address, number]> {
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode("nullifier"), nullifierHash],
  });
  return [result[0], result[1]];
}

async function deriveStealthAnnouncementPDA(
  programId: Address,
  commitment: Uint8Array
): Promise<[Address, number]> {
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode("stealth"), commitment],
  });
  return [result[0], result[1]];
}

/**
 * Simple base58 decoding for addresses
 */
function bs58Decode(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const ALPHABET_MAP = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_MAP.set(ALPHABET[i], i);
  }

  let num = BigInt(0);
  for (const char of str) {
    const val = ALPHABET_MAP.get(char);
    if (val === undefined) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    num = num * BigInt(58) + BigInt(val);
  }

  // Count leading zeros
  let leadingZeros = 0;
  for (const char of str) {
    if (char === "1") {
      leadingZeros++;
    } else {
      break;
    }
  }

  // Convert to bytes
  const bytes: number[] = [];
  while (num > BigInt(0)) {
    bytes.unshift(Number(num % BigInt(256)));
    num = num / BigInt(256);
  }

  // Add leading zeros
  for (let i = 0; i < leadingZeros; i++) {
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
}

/**
 * Convert Address to bytes
 */
function addressToBytes(addr: Address): Uint8Array {
  return bs58Decode(addr.toString());
}

/**
 * Derive Associated Token Account address
 */
async function deriveAssociatedTokenAccount(
  owner: Address,
  mint: Address
): Promise<[Address, number]> {
  const result = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM_ID,
    seeds: [
      addressToBytes(owner),
      addressToBytes(TOKEN_2022_PROGRAM_ID),
      addressToBytes(mint),
    ],
  });
  return [result[0], result[1]];
}

// ============================================================================
// 1. DEPOSIT
// ============================================================================

/** Maximum BTC supply in satoshis (21 million BTC) */
const MAX_SATS = 21_000_000n * 100_000_000n;

/** Minimum dust amount (546 sats - Bitcoin dust limit) */
const MIN_DUST_SATS = 546n;

/**
 * Validate amount in satoshis
 * @throws Error if amount is invalid
 */
function validateAmount(amountSats: bigint, context: string): void {
  if (amountSats <= 0n) {
    throw new Error(`${context}: Amount must be positive`);
  }
  if (amountSats < MIN_DUST_SATS) {
    throw new Error(`${context}: Amount ${amountSats} sats is below dust limit (${MIN_DUST_SATS} sats)`);
  }
  if (amountSats > MAX_SATS) {
    throw new Error(`${context}: Amount exceeds maximum BTC supply`);
  }
}

/**
 * Generate deposit credentials (creates a claim link)
 *
 * Creates a new note with random secrets, derives a taproot address for
 * receiving BTC, and creates a claim link for later claiming.
 *
 * **Flow:**
 * 1. Generate random nullifier + secret
 * 2. Derive taproot address from commitment
 * 3. Create claim link with encoded secrets
 * 4. User sends BTC to taproot address externally
 * 5. Later: call verifyDeposit to add commitment to on-chain tree
 *
 * @param amountSats - Amount in satoshis (must be > 546 sats dust limit)
 * @param network - Bitcoin network (mainnet/testnet)
 * @param baseUrl - Base URL for claim link
 * @returns Deposit credentials with claim link
 * @throws Error if amount is invalid (zero, negative, dust, or exceeds max supply)
 *
 * @example
 * ```typescript
 * const result = await depositToNote(100_000n); // 0.001 BTC
 * console.log('Send BTC to:', result.taprootAddress);
 * console.log('Save this link:', result.claimLink);
 * ```
 */
export async function depositToNote(
  amountSats: bigint,
  network: "mainnet" | "testnet" = "testnet",
  baseUrl?: string
): Promise<DepositResult> {
  // Validate amount
  validateAmount(amountSats, "depositToNote");

  // Generate note with random secrets
  let note = generateNote(amountSats);

  // Compute the commitment using Poseidon hash: Poseidon(pubKeyX, amount)
  note = computeNoteCommitment(note);

  // Derive taproot address from commitment
  const { address: taprootAddress } = await deriveTaprootAddress(
    note.commitmentBytes,
    network
  );

  // Create claim link
  const claimLink = createClaimLink(note, baseUrl);

  return {
    note,
    taprootAddress,
    claimLink,
    displayAmount: formatBtc(amountSats),
  };
}

// ============================================================================
// 2. WITHDRAW
// ============================================================================

/**
 * Request BTC withdrawal (burn zBTC)
 *
 * Generates a partial_withdraw ZK proof and submits REQUEST_REDEMPTION instruction.
 * Burns zBTC tokens and creates a redemption request for the relayer to fulfill.
 *
 * **Flow:**
 * 1. Generate partial_withdraw proof
 * 2. Call REQUEST_REDEMPTION instruction
 * 3. Program verifies proof, burns zBTC, creates RedemptionRequest PDA
 * 4. If partial: adds change commitment to tree
 * 5. Relayer monitors and sends BTC (external)
 *
 * @param config - Client configuration
 * @param note - Note to withdraw from
 * @param btcAddress - Bitcoin address to receive withdrawal
 * @param withdrawAmount - Amount to withdraw (defaults to full amount)
 * @param merkleProof - Merkle proof for the commitment
 * @returns Withdrawal result
 *
 * @example
 * ```typescript
 * // Full withdrawal
 * const result = await withdraw(config, myNote, 'bc1q...');
 *
 * // Partial withdrawal (50%)
 * const result = await withdraw(config, myNote, 'bc1q...', myNote.amount / 2n);
 * ```
 */
export async function withdraw(
  config: ApiClientConfig,
  note: Note,
  btcAddress: string,
  withdrawAmount?: bigint,
  merkleProof?: MerkleProof
): Promise<WithdrawResult> {
  if (!config.payer) {
    throw new Error("Payer keypair required for withdraw");
  }

  const actualWithdrawAmount = withdrawAmount ?? note.amount;

  // Validate withdrawal amount
  validateAmount(actualWithdrawAmount, "withdraw");
  if (actualWithdrawAmount > note.amount) {
    throw new Error(`withdraw: Amount ${actualWithdrawAmount} exceeds note balance ${note.amount}`);
  }

  const isPartialWithdraw = actualWithdrawAmount < note.amount;

  // Hash BTC address for recipient field
  const encoder = new TextEncoder();
  const recipientBytes = new Uint8Array(32);
  const btcAddressBytes = encoder.encode(btcAddress);
  recipientBytes.set(btcAddressBytes.slice(0, Math.min(32, btcAddressBytes.length)));

  let changeNote: Note | undefined;
  let proof: NoirProof;

  if (isPartialWithdraw) {
    // Generate change note for remaining amount
    const changeAmount = note.amount - actualWithdrawAmount;
    changeNote = generateNote(changeAmount);

    // Generate partial withdraw proof
    const mp = merkleProof ?? createEmptyMerkleProofForNote();
    proof = await generatePartialWithdrawProof(
      note,
      actualWithdrawAmount,
      changeNote,
      mp,
      recipientBytes
    );
  } else {
    // Full withdrawal - use partial_withdraw with zero change
    changeNote = generateNote(0n);
    const mp = merkleProof ?? createEmptyMerkleProofForNote();
    proof = await generatePartialWithdrawProof(
      note,
      actualWithdrawAmount,
      changeNote,
      mp,
      recipientBytes
    );
    changeNote = undefined; // No change for full withdrawal
  }

  // Build instruction data
  const data = buildRequestRedemptionData(
    proof,
    actualWithdrawAmount,
    recipientBytes,
    changeNote?.commitmentBytes
  );

  // Derive PDAs
  const [poolState] = await derivePoolStatePDA(config.programId);
  const [commitmentTree] = await deriveCommitmentTreePDA(config.programId);
  const [nullifierRecord] = await deriveNullifierRecordPDA(
    config.programId,
    note.nullifierHashBytes
  );

  // Build instruction (v2 format)
  const ix: Instruction = {
    programAddress: config.programId,
    accounts: [
      { address: poolState, role: AccountRole.WRITABLE },
      { address: commitmentTree, role: AccountRole.WRITABLE },
      { address: nullifierRecord, role: AccountRole.WRITABLE },
      { address: config.payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };

  // Send transaction using the RPC client
  const signature = await sendInstruction(config, ix);
  await config.rpc.confirmTransaction(signature);

  return {
    signature,
    withdrawAmount: actualWithdrawAmount,
    changeNote,
    changeClaimLink: changeNote ? createClaimLink(changeNote) : undefined,
  };
}

// ============================================================================
// 3. CLAIM_NOTE
// ============================================================================

/**
 * Claim zkBTC tokens with ZK proof
 *
 * Parses claim link (or uses provided note), generates a claim proof,
 * and mints zkBTC tokens to the user's wallet.
 *
 * **Flow:**
 * 1. Parse claim link to recover note (if link provided)
 * 2. Get merkle proof for commitment
 * 3. Generate claim ZK proof
 * 4. Call CLAIM instruction
 * 5. Program verifies proof, mints zkBTC
 *
 * @param config - Client configuration
 * @param claimLinkOrNote - Claim link URL or Note object
 * @param merkleProof - Merkle proof for the commitment
 * @returns Claim result
 *
 * @example
 * ```typescript
 * // Claim from link
 * const result = await claimNote(config, 'https://zkbtc.app/claim?note=...');
 *
 * // Claim from note
 * const result = await claimNote(config, myNote);
 * ```
 */
export async function claimNote(
  config: ApiClientConfig,
  claimLinkOrNote: string | Note,
  merkleProof?: MerkleProof
): Promise<ClaimResult> {
  if (!config.payer) {
    throw new Error("Payer keypair required for claim");
  }

  // Parse note from link or use directly
  let note: Note;
  if (typeof claimLinkOrNote === "string") {
    const parsed = parseClaimLink(claimLinkOrNote);
    if (!parsed) {
      throw new Error("Invalid claim link");
    }
    note = parsed;
  } else {
    note = claimLinkOrNote;
  }

  // Use provided merkle proof or create empty one
  const mp = merkleProof ?? createEmptyMerkleProofForNote();

  // Convert payer address to bigint for proof recipient binding (reduced mod BN254 prime)
  const recipientBigint = bytesToBigint(addressToBytes(config.payer.address)) % BN254_FIELD_PRIME;

  // Generate ZK proof
  const proof = await generateClaimProof(note, mp, recipientBigint);

  // Build instruction data
  const data = buildClaimData(proof, note.amount);

  // Derive PDAs
  const [poolState] = await derivePoolStatePDA(config.programId);
  const [commitmentTree] = await deriveCommitmentTreePDA(config.programId);
  const [nullifierRecord] = await deriveNullifierRecordPDA(
    config.programId,
    note.nullifierHashBytes
  );

  // Build instruction (v2 format)
  const ix: Instruction = {
    programAddress: config.programId,
    accounts: [
      { address: poolState, role: AccountRole.WRITABLE },
      { address: commitmentTree, role: AccountRole.READONLY },
      { address: nullifierRecord, role: AccountRole.WRITABLE },
      { address: config.payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };

  // Send transaction using the RPC client
  const signature = await sendInstruction(config, ix);
  await config.rpc.confirmTransaction(signature);

  return {
    signature,
    amount: note.amount,
    recipient: config.payer.address,
  };
}

// ============================================================================
// 3b. CLAIM_PUBLIC (Claim to Public Wallet)
// ============================================================================

/**
 * Claim zkBTC directly to a public Solana wallet
 *
 * Unlike the shielded architecture where tokens stay in the pool, this
 * transfers zkBTC directly to the recipient's wallet for use in regular DeFi.
 *
 * **Flow:**
 * 1. Parse claim link to recover note (if link provided)
 * 2. Generate claim ZK proof (proves ownership of commitment)
 * 3. Call CLAIM_PUBLIC instruction
 * 4. Program verifies proof, records nullifier, transfers zBTC to recipient
 *
 * **Security:**
 * - Amount is revealed (unavoidable for public tokens)
 * - Nullifier is recorded (prevents double-spend)
 * - zBTC is transferred from pool vault to recipient ATA
 *
 * @param config - Client configuration
 * @param claimLinkOrNote - Claim link URL or Note object
 * @param recipient - Recipient wallet address (defaults to payer)
 * @param merkleProof - Merkle proof for the commitment
 * @returns Claim result with transaction details
 *
 * @example
 * ```typescript
 * // Claim to your own wallet
 * const result = await claimPublic(config, 'https://zkbtc.app/claim?note=...');
 *
 * // Claim to a specific recipient
 * const result = await claimPublic(config, myNote, recipientAddress);
 * ```
 */
export async function claimPublic(
  config: ApiClientConfig,
  claimLinkOrNote: string | Note,
  recipient?: Address,
  merkleProof?: MerkleProof
): Promise<ClaimPublicResult> {
  if (!config.payer) {
    throw new Error("Payer keypair required for claim");
  }

  // Parse note from link or use directly
  let note: Note;
  if (typeof claimLinkOrNote === "string") {
    const parsed = parseClaimLink(claimLinkOrNote);
    if (!parsed) {
      throw new Error("Invalid claim link");
    }
    note = parsed;
  } else {
    note = claimLinkOrNote;
  }

  // Default recipient to payer if not specified
  const recipientAddress = recipient ?? config.payer.address;

  // Use provided merkle proof or create empty one
  const mp = merkleProof ?? createEmptyMerkleProofForNote();

  // Convert recipient address to bigint for proof binding (reduced mod BN254 prime)
  const recipientBigint = bytesToBigint(addressToBytes(recipientAddress)) % BN254_FIELD_PRIME;

  // Generate ZK proof
  const proof = await generateClaimProof(note, mp, recipientBigint);

  // Get network config for token addresses
  const networkConfig = getConfig();

  // Derive recipient's ATA for zBTC
  const [recipientAta] = await deriveAssociatedTokenAccount(
    recipientAddress,
    networkConfig.zbtcMint
  );

  // Get VK hash for claim circuit
  const vkHash = hexToBytes(networkConfig.vkHashes.claim);

  // Build instruction data
  const data = buildClaimPublicData(
    proof,
    mp.root,
    note.nullifierHashBytes,
    note.amount,
    recipientAddress,
    vkHash
  );

  // Derive PDAs
  const [poolState] = await derivePoolStatePDA(config.programId);
  const [commitmentTree] = await deriveCommitmentTreePDA(config.programId);
  const [nullifierRecord] = await deriveNullifierRecordPDA(
    config.programId,
    note.nullifierHashBytes
  );

  // Build instruction (v2 format with Groth16 verifier)
  const ix: Instruction = {
    programAddress: config.programId,
    accounts: [
      { address: poolState, role: AccountRole.WRITABLE },
      { address: commitmentTree, role: AccountRole.READONLY },
      { address: nullifierRecord, role: AccountRole.WRITABLE },
      { address: networkConfig.zbtcMint, role: AccountRole.WRITABLE },
      { address: networkConfig.poolVault, role: AccountRole.WRITABLE },
      { address: recipientAta, role: AccountRole.WRITABLE },
      { address: config.payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: networkConfig.token2022ProgramId, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: networkConfig.groth16VerifierProgramId, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };

  // Send transaction using the RPC client
  const signature = await sendInstruction(config, ix);
  await config.rpc.confirmTransaction(signature);

  return {
    signature,
    amount: note.amount,
    recipient: recipientAddress,
    recipientAta,
  };
}

// ============================================================================
// 3c. CLAIM_PUBLIC_STEALTH (Claim Stealth Note to Public Wallet)
// ============================================================================

/**
 * Claim zkBTC from a stealth note to a public Solana wallet
 *
 * This function is for users who received zkBTC via stealth address transfer
 * and want to claim it to their public wallet for use in regular DeFi.
 *
 * **Flow:**
 * 1. Derive stealth private key from viewing key + spending key
 * 2. Compute nullifier from stealth private key
 * 3. Generate claim ZK proof
 * 4. Call CLAIM_PUBLIC instruction
 * 5. Program verifies proof, records nullifier, transfers zBTC to recipient
 *
 * **Security:**
 * - Requires both viewing AND spending keys (full ZVaultKeys)
 * - Amount is revealed (unavoidable for public tokens)
 * - Nullifier prevents double-spend
 *
 * @param config - Client configuration
 * @param keys - User's ZVaultKeys (requires spending key for nullifier derivation)
 * @param scannedNote - Scanned note from scanAnnouncements()
 * @param recipient - Recipient wallet address (defaults to payer)
 * @param merkleProof - Merkle proof for the commitment
 * @returns Claim result with transaction details
 *
 * @example
 * ```typescript
 * // Scan your stealth announcements
 * const notes = await scanAnnouncements(keys, announcements);
 *
 * // Claim to your own wallet
 * const result = await claimPublicStealth(config, keys, notes[0]);
 * console.log(`Claimed ${result.amount} sats to ${result.recipientAta}`);
 * ```
 */
export async function claimPublicStealth(
  config: ApiClientConfig,
  keys: ZVaultKeys,
  scannedNote: ScannedNote,
  recipient?: Address,
  merkleProof?: MerkleProof
): Promise<ClaimPublicStealthResult> {
  if (!config.payer) {
    throw new Error("Payer keypair required for claim");
  }

  // Default recipient to payer if not specified
  const recipientAddress = recipient ?? config.payer.address;

  // Use provided merkle proof or create empty one
  const mp = merkleProof ?? createEmptyMerkleProofForNote();

  // Prepare claim inputs - this derives stealthPrivKey and computes nullifier
  // Requires spending key to derive the stealth private key
  const claimInputs = await prepareClaimInputs(keys, scannedNote, {
    root: bytesToBigint(mp.root),
    pathElements: mp.pathElements.map(el => bytesToBigint(el)),
    pathIndices: mp.pathIndices,
  });

  // The nullifier is computed as: nullifier = Poseidon(stealthPriv, leafIndex)
  // Then nullifier_hash = Poseidon(nullifier)
  const nullifierHash = hashNullifierSync(claimInputs.nullifier);
  const nullifierHashBytes = bigintToBytes(nullifierHash);

  // Generate ZK proof using stealth inputs
  // For now, use the same generateClaimProof but with stealth-derived values
  // In production, this would use a stealth-specific circuit
  const proof = await generateStealthClaimProof(claimInputs, mp);

  // Get network config for token addresses
  const networkConfig = getConfig();

  // Derive recipient's ATA for zBTC
  const [recipientAta] = await deriveAssociatedTokenAccount(
    recipientAddress,
    networkConfig.zbtcMint
  );

  // Get VK hash for claim circuit
  const vkHash = hexToBytes(networkConfig.vkHashes.claim);

  // Build instruction data (same format as claimPublic)
  const data = buildClaimPublicData(
    proof,
    mp.root,
    nullifierHashBytes,
    scannedNote.amount,
    recipientAddress,
    vkHash
  );

  // Derive PDAs
  const [poolState] = await derivePoolStatePDA(config.programId);
  const [commitmentTree] = await deriveCommitmentTreePDA(config.programId);
  const [nullifierRecord] = await deriveNullifierRecordPDA(
    config.programId,
    nullifierHashBytes
  );

  // Build instruction (v2 format with Groth16 verifier)
  const ix: Instruction = {
    programAddress: config.programId,
    accounts: [
      { address: poolState, role: AccountRole.WRITABLE },
      { address: commitmentTree, role: AccountRole.READONLY },
      { address: nullifierRecord, role: AccountRole.WRITABLE },
      { address: networkConfig.zbtcMint, role: AccountRole.WRITABLE },
      { address: networkConfig.poolVault, role: AccountRole.WRITABLE },
      { address: recipientAta, role: AccountRole.WRITABLE },
      { address: config.payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: networkConfig.token2022ProgramId, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: networkConfig.groth16VerifierProgramId, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };

  // Send transaction using the RPC client
  const signature = await sendInstruction(config, ix);
  await config.rpc.confirmTransaction(signature);

  return {
    signature,
    amount: scannedNote.amount,
    recipient: recipientAddress,
    recipientAta,
    nullifierHash: nullifierHashBytes,
  };
}

/**
 * Generate claim proof for stealth note
 *
 * Uses the stealth-derived private key and nullifier instead of note secrets.
 * The circuit proves:
 * 1. Knowledge of stealthPrivKey such that stealthPub = stealthPrivKey * G
 * 2. Commitment = Poseidon(stealthPub.x, amount) exists in tree
 * 3. Nullifier = Poseidon(stealthPrivKey, leafIndex) is correctly computed
 *
 * @throws Error - Stealth claim proof generation not yet implemented
 */
async function generateStealthClaimProof(
  claimInputs: import("./stealth").ClaimInputs,
  merkleProof: MerkleProof
): Promise<NoirProof> {
  // TODO: Implement stealth_claim circuit integration
  // Circuit inputs:
  // - stealth_priv_key: claimInputs.stealthPrivKey (private)
  // - amount: claimInputs.amount (private)
  // - leaf_index: claimInputs.leafIndex (private)
  // - merkle_path: claimInputs.merklePath (private)
  // - path_indices: claimInputs.merkleIndices (private)
  // - merkle_root: claimInputs.merkleRoot (public)
  // - nullifier_hash: hash(claimInputs.nullifier) (public)
  // - amount_pub: claimInputs.amountPub (public)

  throw new Error(
    "Stealth claim proof generation not yet implemented. " +
    "Use claimPublic() with a regular note instead, or wait for stealth_claim circuit support."
  );
}

// ============================================================================
// 4. SPLIT_NOTE
// ============================================================================

/**
 * Split one note into two outputs
 *
 * Generates a split proof and adds two new commitments to the tree
 * while spending the input commitment.
 *
 * **Flow:**
 * 1. Generate two output notes
 * 2. Generate split ZK proof
 * 3. Call SPLIT_COMMITMENT instruction
 * 4. Program verifies proof, nullifies input, adds outputs
 *
 * @param config - Client configuration
 * @param inputNote - Note to split
 * @param amount1 - Amount for first output
 * @param merkleProof - Merkle proof for input commitment
 * @returns Split result with two output notes
 *
 * @example
 * ```typescript
 * // Split 1 BTC into 0.3 + 0.7
 * const { output1, output2 } = await splitNote(config, myNote, 30_000_000n);
 *
 * // Send 0.3 to Alice via stealth
 * await sendPrivate(config, output1, alicePubKey);
 *
 * // Keep 0.7 as claim link
 * const myLink = createClaimLink(output2);
 * ```
 */
export async function splitNote(
  config: ApiClientConfig,
  inputNote: Note,
  amount1: bigint,
  merkleProof?: MerkleProof
): Promise<SplitResult> {
  if (!config.payer) {
    throw new Error("Payer keypair required for split");
  }

  const amount2 = inputNote.amount - amount1;

  // Validate both output amounts
  validateAmount(amount1, "splitNote (output1)");
  validateAmount(amount2, "splitNote (output2)");

  if (amount1 + amount2 !== inputNote.amount) {
    throw new Error("splitNote: Output amounts must equal input amount");
  }

  // Generate output notes
  const output1 = generateNote(amount1);
  const output2 = generateNote(amount2);

  // Use provided merkle proof or create empty one
  const mp = merkleProof ?? createEmptyMerkleProofForNote();

  // Generate split proof
  const proof = await generateSplitProof(inputNote, output1, output2, mp);

  // Build instruction data
  const data = buildSplitData(proof, output1.commitmentBytes, output2.commitmentBytes);

  // Derive PDAs
  const [poolState] = await derivePoolStatePDA(config.programId);
  const [commitmentTree] = await deriveCommitmentTreePDA(config.programId);
  const [nullifierRecord] = await deriveNullifierRecordPDA(
    config.programId,
    inputNote.nullifierHashBytes
  );

  // Build instruction (v2 format)
  const ix: Instruction = {
    programAddress: config.programId,
    accounts: [
      { address: poolState, role: AccountRole.WRITABLE },
      { address: commitmentTree, role: AccountRole.WRITABLE },
      { address: nullifierRecord, role: AccountRole.WRITABLE },
      { address: config.payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };

  const signature = await sendInstruction(config, ix);

  return {
    signature,
    output1,
    output2,
    inputNullifierHash: inputNote.nullifierHashBytes,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create empty merkle proof (for testing/demo)
 */
function createEmptyMerkleProofForNote(): MerkleProof {
  return {
    pathElements: Array(TREE_DEPTH)
      .fill(null)
      .map(() => new Uint8Array(ZERO_VALUE)),
    pathIndices: Array(TREE_DEPTH).fill(0),
    leafIndex: 0,
    root: new Uint8Array(ZERO_VALUE),
  };
}

/**
 * Build claim instruction data (legacy - keeping for compatibility)
 */
function buildClaimData(proof: NoirProof, amount: bigint): Uint8Array {
  // Format: discriminator (1) + proof_len (4) + proof + amount (8)
  const proofBytes = proof.proof;
  const data = new Uint8Array(1 + 4 + proofBytes.length + 8);
  const view = new DataView(data.buffer);

  data[0] = INSTRUCTION.CLAIM;
  view.setUint32(1, proofBytes.length, true);
  data.set(proofBytes, 5);
  view.setBigUint64(5 + proofBytes.length, amount, true);

  return data;
}

/**
 * Build claim instruction data (Groth16 - variable-length proof)
 *
 * Format:
 * - discriminator: 1 byte (9 = CLAIM)
 * - proof_len: 4 bytes (little-endian)
 * - proof: N bytes (Groth16)
 * - root: 32 bytes (Merkle tree root)
 * - nullifier_hash: 32 bytes
 * - amount_sats: 8 bytes (little-endian)
 * - recipient: 32 bytes (Solana wallet address)
 * - vk_hash: 32 bytes (verification key hash)
 */
function buildClaimPublicData(
  proof: NoirProof,
  merkleRoot: Uint8Array,
  nullifierHash: Uint8Array,
  amountSats: bigint,
  recipient: Address,
  vkHash: Uint8Array
): Uint8Array {
  const proofBytes = proof.proof;
  const proofLen = proofBytes.length;

  // Total: 1 + 4 + proofLen + 32 + 32 + 8 + 32 + 32
  const totalSize = 1 + 4 + proofLen + 32 + 32 + 8 + 32 + 32;
  const data = new Uint8Array(totalSize);
  const view = new DataView(data.buffer);

  let offset = 0;

  // Discriminator
  data[offset++] = INSTRUCTION.CLAIM;

  // Proof length (4 bytes, little-endian)
  view.setUint32(offset, proofLen, true);
  offset += 4;

  // Proof (variable length)
  data.set(proofBytes, offset);
  offset += proofLen;

  // Merkle root (32 bytes)
  data.set(merkleRoot, offset);
  offset += 32;

  // Nullifier hash (32 bytes)
  data.set(nullifierHash, offset);
  offset += 32;

  // Amount in satoshis (8 bytes, little-endian)
  view.setBigUint64(offset, amountSats, true);
  offset += 8;

  // Recipient address (32 bytes)
  data.set(addressToBytes(recipient), offset);
  offset += 32;

  // VK hash (32 bytes)
  data.set(vkHash, offset);

  return data;
}

/**
 * Build split instruction data
 */
function buildSplitData(
  proof: NoirProof,
  outputCommitment1: Uint8Array,
  outputCommitment2: Uint8Array
): Uint8Array {
  // Format: discriminator (1) + proof_len (4) + proof + output1 (32) + output2 (32)
  const proofBytes = proof.proof;
  const data = new Uint8Array(1 + 4 + proofBytes.length + 64);
  const view = new DataView(data.buffer);

  data[0] = INSTRUCTION.SPEND_SPLIT;
  view.setUint32(1, proofBytes.length, true);
  data.set(proofBytes, 5);
  data.set(outputCommitment1, 5 + proofBytes.length);
  data.set(outputCommitment2, 5 + proofBytes.length + 32);

  return data;
}

/**
 * Build request redemption instruction data
 */
function buildRequestRedemptionData(
  proof: NoirProof,
  withdrawAmount: bigint,
  recipient: Uint8Array,
  changeCommitment?: Uint8Array
): Uint8Array {
  const proofBytes = proof.proof;
  const hasChange = changeCommitment !== undefined;

  // Format: discriminator (1) + proof_len (4) + proof + amount (8) + recipient (32) + has_change (1) + [change_commitment (32)]
  const dataLen = 1 + 4 + proofBytes.length + 8 + 32 + 1 + (hasChange ? 32 : 0);
  const data = new Uint8Array(dataLen);
  const view = new DataView(data.buffer);

  let offset = 0;
  data[offset++] = INSTRUCTION.REQUEST_REDEMPTION;
  view.setUint32(offset, proofBytes.length, true);
  offset += 4;
  data.set(proofBytes, offset);
  offset += proofBytes.length;
  view.setBigUint64(offset, withdrawAmount, true);
  offset += 8;
  data.set(recipient, offset);
  offset += 32;
  data[offset++] = hasChange ? 1 : 0;
  if (hasChange && changeCommitment) {
    data.set(changeCommitment, offset);
  }

  return data;
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export { generateNote, createNoteFromSecrets, deriveNote, deriveNotes, estimateSeedStrength } from "./note";
export { parseClaimLink } from "./claim-link";
export {
  scanAnnouncements,
  prepareClaimInputs,
  isWalletAdapter,
} from "./stealth";
export type { Note } from "./note";
export type { MerkleProof } from "./merkle";
export type { StealthDeposit, ScannedNote, ClaimInputs } from "./stealth";
export type { StealthMetaAddress, ZVaultKeys } from "./keys";
