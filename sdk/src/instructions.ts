/**
 * AEGIS Instruction Builders (JoinSplit Architecture)
 *
 * Low-level instruction building for AEGIS operations.
 * All Groth16 proofs are verified inline using BN254 pairing syscalls.
 *
 * @module instructions
 */

import {
  AccountRole,
  type Address,
} from "@solana/kit";

import { address, getConfig, TOKEN_2022_PROGRAM_ID } from "./config";

/** System program address */
const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");

// =============================================================================
// Types
// =============================================================================

/** Instruction type for v2 */
export interface Instruction {
  programAddress: Address;
  accounts: Array<{ address: Address; role: (typeof AccountRole)[keyof typeof AccountRole] }>;
  data: Uint8Array;
}

// =============================================================================
// Constants
// =============================================================================

/** Instruction discriminators (must match contracts/programs/aegis/src/lib.rs) */
const INSTRUCTION = {
  // Core operations
  INITIALIZE: 0,
  VERIFY_STEALTH_DEPOSIT: 1,
  MARK_PROCESSING: 2,
  CANCEL_REDEMPTION: 3,
  REQUEST_REDEMPTION: 5,
  COMPLETE_REDEMPTION: 6,
  SET_PAUSED: 7,
  // VK Registry
  INIT_VK_REGISTRY: 11,
  UPDATE_VK_REGISTRY: 12,
  ADD_DEMO_STEALTH: 13,
  // JoinSplit
  TRANSACT: 14,
  // Timelocked pool updates
  PROPOSE_POOL_UPDATE: 21,
  EXECUTE_POOL_UPDATE: 22,
  CANCEL_POOL_UPDATE: 23,
  // Multi-token instructions
  REGISTER_TOKEN: 28,
  SHIELD: 29,
  UNSHIELD: 30,
  UPDATE_TOKEN_CONFIG: 31,
  CLAIM_FEES: 32,
} as const;

/** Export instruction discriminators for consumers */
export const INSTRUCTION_DISCRIMINATORS = INSTRUCTION;

// =============================================================================
// Utilities
// =============================================================================

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

  // Ensure 32 bytes for Solana addresses
  while (bytes.length < 32) {
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

// =============================================================================
// Redemption Request Instruction Builder
// =============================================================================

/**
 * Build instruction data for REQUEST_REDEMPTION (disc 5)
 *
 * Escrow-based: locks zkBTC by decrementing total_shielded. Does NOT burn tokens.
 *
 * Layout (after disc stripped):
 * - proof_hash: [u8; 32] — SHA256 of ZK proof (all zeros = demo mode)
 * - merkle_root: [u8; 32]
 * - nullifier_hash: [u8; 32]
 * - amount_sats: u64 LE
 * - vk_hash: [u8; 32] — verification key hash (all zeros = demo mode)
 * - btc_script_len: u8
 * - btc_script: [u8; 0-34]
 * - request_nonce: u64 LE
 */
export function buildRedemptionRequestInstructionData(options: {
  proofHash: Uint8Array;
  merkleRoot: Uint8Array;
  nullifierHash: Uint8Array;
  amountSats: bigint;
  vkHash: Uint8Array;
  btcScript: Uint8Array;
  requestNonce: bigint;
}): Uint8Array {
  const { proofHash, merkleRoot, nullifierHash, amountSats, vkHash, btcScript, requestNonce } = options;

  if (btcScript.length > 34) {
    throw new Error("BTC scriptPubKey too long (max 34 bytes)");
  }

  // disc(1) + proof_hash(32) + merkle_root(32) + nullifier_hash(32) + amount(8) + vk_hash(32) + script_len(1) + script(var) + nonce(8)
  const totalLen = 1 + 32 + 32 + 32 + 8 + 32 + 1 + btcScript.length + 8;
  const data = new Uint8Array(totalLen);
  const view = new DataView(data.buffer);

  let offset = 0;
  data[offset++] = INSTRUCTION.REQUEST_REDEMPTION;

  data.set(proofHash, offset); offset += 32;
  data.set(merkleRoot, offset); offset += 32;
  data.set(nullifierHash, offset); offset += 32;
  view.setBigUint64(offset, amountSats, true); offset += 8;
  data.set(vkHash, offset); offset += 32;
  data[offset++] = btcScript.length;
  data.set(btcScript, offset); offset += btcScript.length;
  view.setBigUint64(offset, requestNonce, true);

  return data;
}

/** Redemption request instruction options */
export interface RedemptionRequestInstructionOptions {
  /** SHA256 of ZK proof (all zeros = demo mode) */
  proofHash: Uint8Array;
  /** Current merkle tree root */
  merkleRoot: Uint8Array;
  /** Nullifier hash */
  nullifierHash: Uint8Array;
  /** Amount to redeem in satoshis */
  amountSats: bigint;
  /** Verification key hash (all zeros = demo mode) */
  vkHash: Uint8Array;
  /** Bitcoin scriptPubKey for withdrawal (raw bytes) */
  btcScript: Uint8Array;
  /** Unique request nonce */
  requestNonce: bigint;
  /** Account addresses */
  accounts: {
    poolState: Address;
    commitmentTree: Address;
    nullifierRecord: Address;
    redemptionRequest: Address;
    user: Address;
    tokenConfig: Address;
  };
}

/**
 * Build a complete redemption request instruction
 *
 * Accounts (7):
 * 0. pool_state (writable)
 * 1. commitment_tree (readonly)
 * 2. nullifier_record (writable)
 * 3. redemption_request (writable)
 * 4. user (signer)
 * 5. system_program (readonly)
 * 6. token_config (writable)
 */
export function buildRedemptionRequestInstruction(
  options: RedemptionRequestInstructionOptions
): Instruction {
  const config = getConfig();

  const data = buildRedemptionRequestInstructionData({
    proofHash: options.proofHash,
    merkleRoot: options.merkleRoot,
    nullifierHash: options.nullifierHash,
    amountSats: options.amountSats,
    vkHash: options.vkHash,
    btcScript: options.btcScript,
    requestNonce: options.requestNonce,
  });

  const accounts: Instruction["accounts"] = [
    { address: options.accounts.poolState, role: AccountRole.WRITABLE },
    { address: options.accounts.commitmentTree, role: AccountRole.READONLY },
    { address: options.accounts.nullifierRecord, role: AccountRole.WRITABLE },
    { address: options.accounts.redemptionRequest, role: AccountRole.WRITABLE },
    { address: options.accounts.user, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: options.accounts.tokenConfig, role: AccountRole.WRITABLE },
  ];

  return {
    programAddress: config.aegisProgramId,
    accounts,
    data,
  };
}

// =============================================================================
// Complete Redemption Instruction Builder
// =============================================================================

/** Complete redemption instruction options */
export interface CompleteRedemptionInstructionOptions {
  /** BTC transaction ID (internal byte order, 32 bytes) */
  btcTxid: Uint8Array;
  /** Raw tx size in ChadBuffer */
  txSize: number;
  /** Pool scriptPubKey for change UTXO tracking (empty = no tracking) */
  poolScript: Uint8Array;
  /** Number of consumed UTXO PDAs in remaining accounts */
  consumedUtxoCount: number;
  /** Account addresses */
  accounts: {
    poolState: Address;
    redemptionRequest: Address;
    authority: Address;
    rentRecipient: Address;
    verifiedTransaction: Address;
    lightClient: Address;
    txBuffer: Address;
    zkbtcMint: Address;
    poolVault: Address;
    completionReceipt: Address;
    poolConfig: Address;
    /** Change UTXO PDA (system program if no change tracking) */
    changeUtxo: Address;
    /** Consumed UTXO PDAs to close */
    consumedUtxos?: Address[];
  };
}

/**
 * Build instruction data for COMPLETE_REDEMPTION (disc 6)
 *
 * Layout (after disc stripped):
 * - btc_txid: [u8; 32]
 * - tx_size: u32 LE
 * - pool_script_len: u8
 * - pool_script: [u8; 0-34]
 * - consumed_utxo_count: u8
 */
export function buildCompleteRedemptionInstructionData(options: {
  btcTxid: Uint8Array;
  txSize: number;
  poolScript: Uint8Array;
  consumedUtxoCount: number;
}): Uint8Array {
  const { btcTxid, txSize, poolScript, consumedUtxoCount } = options;

  const totalLen = 1 + 32 + 4 + 1 + poolScript.length + 1;
  const data = new Uint8Array(totalLen);
  const view = new DataView(data.buffer);

  let offset = 0;
  data[offset++] = INSTRUCTION.COMPLETE_REDEMPTION;

  data.set(btcTxid, offset); offset += 32;
  view.setUint32(offset, txSize, true); offset += 4;
  data[offset++] = poolScript.length;
  if (poolScript.length > 0) {
    data.set(poolScript, offset); offset += poolScript.length;
  }
  data[offset++] = consumedUtxoCount;

  return data;
}

/**
 * Build a complete redemption instruction
 *
 * Accounts (13+):
 * 0.  pool_state (writable)
 * 1.  redemption_request (writable)
 * 2.  authority (signer)
 * 3.  rent_recipient (readonly)
 * 4.  verified_transaction (readonly)
 * 5.  light_client (readonly)
 * 6.  tx_buffer (readonly)
 * 7.  zkbtc_mint (writable)
 * 8.  pool_vault (writable)
 * 9.  token_program (readonly)
 * 10. completion_receipt (writable)
 * 11. system_program (readonly)
 * 12. pool_config (readonly)
 * 13. change_utxo (writable)
 * 14+ consumed_utxos (writable)
 */
export function buildCompleteRedemptionInstruction(
  options: CompleteRedemptionInstructionOptions
): Instruction {
  const config = getConfig();

  const data = buildCompleteRedemptionInstructionData({
    btcTxid: options.btcTxid,
    txSize: options.txSize,
    poolScript: options.poolScript,
    consumedUtxoCount: options.consumedUtxoCount,
  });

  const accounts: Instruction["accounts"] = [
    { address: options.accounts.poolState, role: AccountRole.WRITABLE },
    { address: options.accounts.redemptionRequest, role: AccountRole.WRITABLE },
    { address: options.accounts.authority, role: AccountRole.WRITABLE_SIGNER },
    { address: options.accounts.rentRecipient, role: AccountRole.READONLY },
    { address: options.accounts.verifiedTransaction, role: AccountRole.READONLY },
    { address: options.accounts.lightClient, role: AccountRole.READONLY },
    { address: options.accounts.txBuffer, role: AccountRole.READONLY },
    { address: options.accounts.zkbtcMint, role: AccountRole.WRITABLE },
    { address: options.accounts.poolVault, role: AccountRole.WRITABLE },
    { address: TOKEN_2022_PROGRAM_ID, role: AccountRole.READONLY },
    { address: options.accounts.completionReceipt, role: AccountRole.WRITABLE },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: options.accounts.poolConfig, role: AccountRole.READONLY },
    { address: options.accounts.changeUtxo, role: AccountRole.WRITABLE },
  ];

  // Append consumed UTXO PDAs
  if (options.accounts.consumedUtxos) {
    for (const utxo of options.accounts.consumedUtxos) {
      accounts.push({ address: utxo, role: AccountRole.WRITABLE });
    }
  }

  return {
    programAddress: config.aegisProgramId,
    accounts,
    data,
  };
}

// =============================================================================
// JoinSplit Transact Instruction Builder
// =============================================================================

/** JoinSplit transact instruction options */
export interface TransactInstructionOptions {
  /** Number of input notes being spent */
  nInputs: number;
  /** Number of output notes being created */
  nOutputs: number;
  /** Groth16 proof bytes (256 bytes) */
  proofBytes: Uint8Array;
  /** Merkle root */
  merkleRoot: Uint8Array;
  /** Bound parameters hash */
  boundParamsHash: Uint8Array;
  /** Nullifiers (32 bytes each) */
  nullifiers: Uint8Array[];
  /** Output commitments (32 bytes each) */
  commitmentsOut: Uint8Array[];
  /** Per-output stealth data: ephemeral_pub (32) + encrypted_amount (8) */
  stealthData: Uint8Array[];
  /** Account addresses */
  accounts: {
    poolState: Address;
    commitmentTree: Address;
    vkRegistry: Address;
    user: Address;
    /** Nullifier record PDAs (one per input) */
    nullifierRecords: Address[];
  };
}

/**
 * Build transact instruction data (JoinSplit)
 *
 * Layout (after disc stripped by entrypoint):
 * - n_inputs: u8
 * - n_outputs: u8
 * - proof_source: u8 (0=inline, 1=buffer account)
 * - proof: [u8; 256] (only if proof_source=0)
 * - merkle_root: [u8; 32]
 * - bound_params_hash: [u8; 32]
 * - nullifiers: [[u8; 32]; n_inputs]
 * - commitments_out: [[u8; 32]; n_outputs]
 * - stealth_data: [ephemeral_pub(32) + encrypted_amount(8) + encrypted_token_id(32)] x n_outputs
 */
export function buildTransactInstructionData(options: {
  nInputs: number;
  nOutputs: number;
  proofBytes: Uint8Array;
  merkleRoot: Uint8Array;
  boundParamsHash: Uint8Array;
  nullifiers: Uint8Array[];
  commitmentsOut: Uint8Array[];
  stealthData: Uint8Array[];
}): Uint8Array {
  const { nInputs, nOutputs, proofBytes, merkleRoot, boundParamsHash, nullifiers, commitmentsOut, stealthData } = options;

  if (proofBytes.length !== 256) {
    throw new Error(`Groth16 proof must be 256 bytes, got ${proofBytes.length}`);
  }
  if (nullifiers.length !== nInputs) {
    throw new Error(`Expected ${nInputs} nullifiers, got ${nullifiers.length}`);
  }
  if (commitmentsOut.length !== nOutputs) {
    throw new Error(`Expected ${nOutputs} commitments, got ${commitmentsOut.length}`);
  }
  if (stealthData.length !== nOutputs) {
    throw new Error(`Expected ${nOutputs} stealth data entries, got ${stealthData.length}`);
  }

  const STEALTH_DATA_PER_OUTPUT = 72; // ephemeral_pub(32) + encrypted_amount(8) + encrypted_token_id(32)
  // disc(1) + n_inputs(1) + n_outputs(1) + proof_source(1) + proof(256) + merkle_root(32) + bound_params_hash(32) + ...
  const totalSize = 1 + 3 + 256 + 32 + 32 + (nInputs * 32) + (nOutputs * 32) + (nOutputs * STEALTH_DATA_PER_OUTPUT);
  const data = new Uint8Array(totalSize);

  let offset = 0;

  // Discriminator
  data[offset++] = INSTRUCTION.TRANSACT;

  // Header
  data[offset++] = nInputs;
  data[offset++] = nOutputs;
  data[offset++] = 0; // proof_source = 0 (inline proof)

  // Proof (256 bytes)
  data.set(proofBytes, offset);
  offset += 256;

  // Merkle root (32 bytes)
  data.set(merkleRoot, offset);
  offset += 32;

  // Bound params hash (32 bytes)
  data.set(boundParamsHash, offset);
  offset += 32;

  // Nullifiers
  for (const nullifier of nullifiers) {
    data.set(nullifier, offset);
    offset += 32;
  }

  // Output commitments
  for (const commitment of commitmentsOut) {
    data.set(commitment, offset);
    offset += 32;
  }

  // Stealth data (ephemeral_pub + encrypted_amount per output)
  for (const sd of stealthData) {
    data.set(sd.slice(0, STEALTH_DATA_PER_OUTPUT), offset);
    offset += STEALTH_DATA_PER_OUTPUT;
  }

  return data;
}

/**
 * Build a complete JoinSplit transact instruction
 *
 * Accounts:
 * 0. pool_state (writable)
 * 1. commitment_tree (writable)
 * 2. vk_registry (read)
 * 3. user (signer)
 * 4. system_program (read)
 * 5..5+N nullifier_records (writable)
 */
export function buildTransactInstruction(options: TransactInstructionOptions): Instruction {
  const config = getConfig();

  const data = buildTransactInstructionData({
    nInputs: options.nInputs,
    nOutputs: options.nOutputs,
    proofBytes: options.proofBytes,
    merkleRoot: options.merkleRoot,
    boundParamsHash: options.boundParamsHash,
    nullifiers: options.nullifiers,
    commitmentsOut: options.commitmentsOut,
    stealthData: options.stealthData,
  });

  const accounts: Instruction["accounts"] = [
    { address: options.accounts.poolState, role: AccountRole.WRITABLE },
    { address: options.accounts.commitmentTree, role: AccountRole.WRITABLE },
    { address: options.accounts.vkRegistry, role: AccountRole.READONLY },
    { address: options.accounts.user, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
  ];

  // Nullifier records (writable PDAs)
  for (const nr of options.accounts.nullifierRecords) {
    accounts.push({ address: nr, role: AccountRole.WRITABLE });
  }

  return {
    programAddress: config.aegisProgramId,
    accounts,
    data,
  };
}

// =============================================================================
// Public Unshield Instruction Builder
// =============================================================================

/** Unshield instruction options */
export interface UnshieldInstructionOptions {
  /** Number of input notes being spent */
  nInputs: number;
  /** Number of output notes (includes burn output as last) */
  nOutputs: number;
  /** Groth16 proof bytes (256 bytes) */
  proofBytes: Uint8Array;
  /** Merkle root */
  merkleRoot: Uint8Array;
  /** Bound parameters hash */
  boundParamsHash: Uint8Array;
  /** Nullifiers (32 bytes each) */
  nullifiers: Uint8Array[];
  /** Output commitments (32 bytes each, last = burn commitment) */
  commitmentsOut: Uint8Array[];
  /** Per-output stealth data for tree outputs only (n_outputs - 1 entries) */
  stealthData: Uint8Array[];
  /** Amount being unshielded */
  unshieldAmount: bigint;
  /** Account addresses */
  accounts: {
    poolState: Address;
    commitmentTree: Address;
    vkRegistry: Address;
    user: Address;
    tokenConfig: Address;
    vault: Address;
    userTokenAccount: Address;
    /** Nullifier record PDAs (one per input) */
    nullifierRecords: Address[];
  };
}

/**
 * Build unshield instruction data (multi-token version, disc 30).
 *
 * Layout: disc(1) + n_inputs(1) + n_outputs(1) + proof(256) + merkle_root(32)
 *       + bound_params_hash(32) + nullifiers(N*32) + commitments_out(M*32)
 *       + stealth_data((M-1)*40) + unshield_amount(8)
 *
 * No unshield_address — burn commitment uses Poseidon([0], token_id, amount).
 */
export function buildUnshieldInstructionData(options: {
  nInputs: number;
  nOutputs: number;
  proofBytes: Uint8Array;
  merkleRoot: Uint8Array;
  boundParamsHash: Uint8Array;
  nullifiers: Uint8Array[];
  commitmentsOut: Uint8Array[];
  stealthData: Uint8Array[];
  unshieldAmount: bigint;
}): Uint8Array {
  const { nInputs, nOutputs, proofBytes, merkleRoot, boundParamsHash, nullifiers, commitmentsOut, stealthData, unshieldAmount } = options;

  if (proofBytes.length !== 256) {
    throw new Error(`Groth16 proof must be 256 bytes, got ${proofBytes.length}`);
  }
  if (nullifiers.length !== nInputs) {
    throw new Error(`Expected ${nInputs} nullifiers, got ${nullifiers.length}`);
  }
  if (commitmentsOut.length !== nOutputs) {
    throw new Error(`Expected ${nOutputs} commitments, got ${commitmentsOut.length}`);
  }
  const nTreeOutputs = nOutputs - 1;
  if (stealthData.length !== nTreeOutputs) {
    throw new Error(`Expected ${nTreeOutputs} stealth data entries (tree outputs), got ${stealthData.length}`);
  }

  const STEALTH_DATA_PER_OUTPUT = 72; // ephemeral_pub(32) + encrypted_amount(8) + encrypted_token_id(32)
  const totalSize = 1 + 2 + 256 + 32 + 32 + (nInputs * 32) + (nOutputs * 32) + (nTreeOutputs * STEALTH_DATA_PER_OUTPUT) + 8;
  const data = new Uint8Array(totalSize);
  const view = new DataView(data.buffer);

  let offset = 0;

  // Discriminator
  data[offset++] = INSTRUCTION.UNSHIELD;

  // Header
  data[offset++] = nInputs;
  data[offset++] = nOutputs;

  // Proof (256 bytes)
  data.set(proofBytes, offset);
  offset += 256;

  // Merkle root (32 bytes)
  data.set(merkleRoot, offset);
  offset += 32;

  // Bound params hash (32 bytes)
  data.set(boundParamsHash, offset);
  offset += 32;

  // Nullifiers
  for (const nullifier of nullifiers) {
    data.set(nullifier, offset);
    offset += 32;
  }

  // Output commitments (all n_outputs, last = burn)
  for (const commitment of commitmentsOut) {
    data.set(commitment, offset);
    offset += 32;
  }

  // Stealth data for tree outputs only (n_outputs - 1)
  for (const sd of stealthData) {
    data.set(sd.slice(0, STEALTH_DATA_PER_OUTPUT), offset);
    offset += STEALTH_DATA_PER_OUTPUT;
  }

  // Unshield amount (u64 LE)
  view.setBigUint64(offset, unshieldAmount, true);

  return data;
}

/**
 * Build a complete unshield instruction (multi-token, disc 30)
 *
 * Accounts:
 * 0. pool_state (read)
 * 1. commitment_tree (writable)
 * 2. vk_registry (read)
 * 3. user (signer)
 * 4. system_program (read)
 * 5. token_config (writable)
 * 6. vault (writable)
 * 7. user_token_account (writable)
 * 8. token_program (read)
 * 9..9+N nullifier_records (writable)
 */
export function buildUnshieldInstruction(options: UnshieldInstructionOptions): Instruction {
  const config = getConfig();

  const data = buildUnshieldInstructionData({
    nInputs: options.nInputs,
    nOutputs: options.nOutputs,
    proofBytes: options.proofBytes,
    merkleRoot: options.merkleRoot,
    boundParamsHash: options.boundParamsHash,
    nullifiers: options.nullifiers,
    commitmentsOut: options.commitmentsOut,
    stealthData: options.stealthData,
    unshieldAmount: options.unshieldAmount,
  });

  const accounts: Instruction["accounts"] = [
    { address: options.accounts.poolState, role: AccountRole.READONLY },
    { address: options.accounts.commitmentTree, role: AccountRole.WRITABLE },
    { address: options.accounts.vkRegistry, role: AccountRole.READONLY },
    { address: options.accounts.user, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: options.accounts.tokenConfig, role: AccountRole.WRITABLE },
    { address: options.accounts.vault, role: AccountRole.WRITABLE },
    { address: options.accounts.userTokenAccount, role: AccountRole.WRITABLE },
    { address: TOKEN_2022_PROGRAM_ID, role: AccountRole.READONLY },
  ];

  // Nullifier records (writable PDAs)
  for (const nr of options.accounts.nullifierRecords) {
    accounts.push({ address: nr, role: AccountRole.WRITABLE });
  }

  return {
    programAddress: config.aegisProgramId,
    accounts,
    data,
  };
}

// Redeem and PublicRedeem instructions removed — use request_redemption for BTC withdrawals
// =============================================================================
// Timelocked Pool Update Instruction Builders
// =============================================================================

/** Propose pool update instruction options */
export interface ProposePoolUpdateOptions {
  /** New minimum deposit in satoshis */
  minDeposit: bigint;
  /** New maximum deposit in satoshis */
  maxDeposit: bigint;
  /** New service fee base in satoshis */
  serviceFee: bigint;
  /** Service fee in basis points (e.g. 30 = 0.3%). Applied immediately, no timelock. */
  serviceFeeBps?: number;
  /** Account addresses */
  accounts: {
    poolState: Address;
    authority: Address;
  };
}

/**
 * Build propose_pool_update instruction data
 *
 * Layout: discriminator(1) + min_deposit(8) + max_deposit(8) + service_fee(8) + [service_fee_bps(2)] = 25 or 27 bytes
 */
export function buildProposePoolUpdateInstructionData(
  minDeposit: bigint,
  maxDeposit: bigint,
  serviceFee: bigint,
  serviceFeeBps?: number,
): Uint8Array {
  const hasBps = serviceFeeBps !== undefined;
  const data = new Uint8Array(hasBps ? 27 : 25);
  const view = new DataView(data.buffer);

  data[0] = INSTRUCTION.PROPOSE_POOL_UPDATE;
  view.setBigUint64(1, minDeposit, true);
  view.setBigUint64(9, maxDeposit, true);
  view.setBigUint64(17, serviceFee, true);

  if (hasBps) {
    view.setUint16(25, serviceFeeBps, true);
  }

  return data;
}

/**
 * Build a complete propose_pool_update instruction
 *
 * Accounts:
 * 0. pool_state (writable)
 * 1. authority (signer)
 */
export function buildProposePoolUpdateInstruction(options: ProposePoolUpdateOptions): Instruction {
  const config = getConfig();

  const data = buildProposePoolUpdateInstructionData(
    options.minDeposit,
    options.maxDeposit,
    options.serviceFee,
    options.serviceFeeBps,
  );

  return {
    programAddress: config.aegisProgramId,
    accounts: [
      { address: options.accounts.poolState, role: AccountRole.WRITABLE },
      { address: options.accounts.authority, role: AccountRole.WRITABLE_SIGNER },
    ],
    data,
  };
}

/** Execute pool update instruction options */
export interface ExecutePoolUpdateOptions {
  accounts: {
    poolState: Address;
  };
}

/**
 * Build execute_pool_update instruction data
 *
 * Layout: discriminator(1) = 1 byte
 */
export function buildExecutePoolUpdateInstructionData(): Uint8Array {
  return new Uint8Array([INSTRUCTION.EXECUTE_POOL_UPDATE]);
}

/**
 * Build a complete execute_pool_update instruction (permissionless)
 *
 * Accounts:
 * 0. pool_state (writable)
 */
export function buildExecutePoolUpdateInstruction(options: ExecutePoolUpdateOptions): Instruction {
  const config = getConfig();

  return {
    programAddress: config.aegisProgramId,
    accounts: [
      { address: options.accounts.poolState, role: AccountRole.WRITABLE },
    ],
    data: buildExecutePoolUpdateInstructionData(),
  };
}

/** Cancel pool update instruction options */
export interface CancelPoolUpdateOptions {
  accounts: {
    poolState: Address;
    authority: Address;
  };
}

/**
 * Build cancel_pool_update instruction data
 *
 * Layout: discriminator(1) = 1 byte
 */
export function buildCancelPoolUpdateInstructionData(): Uint8Array {
  return new Uint8Array([INSTRUCTION.CANCEL_POOL_UPDATE]);
}

/**
 * Build a complete cancel_pool_update instruction
 *
 * Accounts:
 * 0. pool_state (writable)
 * 1. authority (signer)
 */
export function buildCancelPoolUpdateInstruction(options: CancelPoolUpdateOptions): Instruction {
  const config = getConfig();

  return {
    programAddress: config.aegisProgramId,
    accounts: [
      { address: options.accounts.poolState, role: AccountRole.WRITABLE },
      { address: options.accounts.authority, role: AccountRole.WRITABLE_SIGNER },
    ],
    data: buildCancelPoolUpdateInstructionData(),
  };
}

// =============================================================================
// Redemption Request PDA Derivation
// =============================================================================

/**
 * Derive RedemptionRequest PDA
 *
 * Seeds: ["redemption", user_pubkey, nonce_le_bytes]
 */
export function deriveRedemptionRequestPDA(
  userAddress: Address,
  nonce: bigint,
  programAddress?: Address,
): { address: Uint8Array; seeds: Uint8Array[] } {
  const userBytes = addressToBytes(userAddress);
  const nonceBytes = new Uint8Array(8);
  const view = new DataView(nonceBytes.buffer);
  view.setBigUint64(0, nonce, true);

  return {
    address: userBytes, // Caller should use getProgramDerivedAddress
    seeds: [
      new TextEncoder().encode("redemption"),
      userBytes,
      nonceBytes,
    ],
  };
}

// =============================================================================
// Utility Exports
// =============================================================================

/**
 * Bigint to 32-byte Uint8Array (big-endian)
 */
export function bigintTo32Bytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * 32-byte Uint8Array to bigint (big-endian)
 */
export function bytes32ToBigint(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) {
    throw new Error("Expected 32 bytes");
  }
  let hex = "0x";
  for (let i = 0; i < 32; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return BigInt(hex);
}

/**
 * Convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
