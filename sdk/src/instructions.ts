/**
 * UTXOPIA Instruction Builders (JoinSplit Architecture)
 *
 * Low-level instruction building for UTXOPIA operations.
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

/** Instruction discriminators — sequential 0-19 (must match contracts/programs/utxopia/src/lib.rs) */
const INSTRUCTION = {
  // Core (0-2)
  INITIALIZE: 0,
  SET_PAUSED: 1,
  SET_POOL_CONFIG: 2,
  // Pool updates (3-5)
  PROPOSE_POOL_UPDATE: 3,
  EXECUTE_POOL_UPDATE: 4,
  CANCEL_POOL_UPDATE: 5,
  // VK admin (6-7)
  INIT_VK_REGISTRY: 6,
  UPDATE_VK_REGISTRY: 7,
  // Multi-token (8-10)
  REGISTER_TOKEN: 8,
  UPDATE_TOKEN_CONFIG: 9,
  CLAIM_FEES: 10,
  // Deposit (11-12)
  COMPLETE_DEPOSIT: 11,
  SHIELD: 12,
  // JoinSplit (13-15) — all share n_in + n_out + n_pub + proof_source header
  TRANSACT: 13,
  UNSHIELD: 14,
  REDEEM: 15,
  // Redemption lifecycle (16-19)
  REQUEST_REDEMPTION: 16,
  COMPLETE_REDEMPTION: 17,
  MARK_PROCESSING: 18,
  CANCEL_REDEMPTION: 19,
  // Tree management (20)
  ROTATE_TREE: 20,
  // Proof of Innocence (21-22)
  UPDATE_ASSOCIATION_ROOT: 21,
  ATTEST_POI: 22,
  APPROVE_REDEMPTION_SIGNING: 27,
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
// Shield Instruction Builder (disc=12)
// =============================================================================

/** Shield instruction options */
export interface ShieldInstructionOptions {
  /** Amount to shield (in token's smallest unit — lamports, micro-USDC, sats) */
  amount: bigint;
  /** NPK bytes (32) — recipient's note public key */
  npk: Uint8Array;
  /** Ephemeral public key (32) — for stealth address derivation */
  ephemeralPub: Uint8Array;
  /** Accounts required for the shield instruction */
  accounts: {
    user: Address;
    userTokenAccount: Address;
    poolState: Address;
    tokenConfig: Address;
    vault: Address;
    commitmentTree: Address;
    tokenProgram: Address;
  };
}

/**
 * Build shield instruction data (disc=12).
 *
 * Layout (after disc stripped by entrypoint):
 * - amount: u64 LE (8 bytes)
 * - npk: [u8; 32]
 * - ephemeral_pub: [u8; 32]
 */
export function buildShieldInstructionData(options: {
  amount: bigint;
  npk: Uint8Array;
  ephemeralPub: Uint8Array;
}): Uint8Array {
  const data = new Uint8Array(73);
  data[0] = INSTRUCTION.SHIELD;
  const view = new DataView(data.buffer);
  view.setBigUint64(1, options.amount, true);
  data.set(options.npk.slice(0, 32), 9);
  data.set(options.ephemeralPub.slice(0, 32), 41);
  return data;
}

/**
 * Build a complete shield instruction (disc=12).
 *
 * Shields SPL tokens into the privacy pool. Works with both
 * legacy Token program (wSOL) and Token-2022 (USDC, USDT, etc.).
 */
export function buildShieldInstruction(options: ShieldInstructionOptions): Instruction {
  const config = getConfig();
  const data = buildShieldInstructionData({
    amount: options.amount,
    npk: options.npk,
    ephemeralPub: options.ephemeralPub,
  });

  return {
    programAddress: config.utxopiaProgramId,
    accounts: [
      { address: options.accounts.user, role: AccountRole.WRITABLE_SIGNER },
      { address: options.accounts.userTokenAccount, role: AccountRole.WRITABLE },
      { address: options.accounts.poolState, role: AccountRole.READONLY },
      { address: options.accounts.tokenConfig, role: AccountRole.WRITABLE },
      { address: options.accounts.vault, role: AccountRole.WRITABLE },
      { address: options.accounts.commitmentTree, role: AccountRole.WRITABLE },
      { address: options.accounts.tokenProgram, role: AccountRole.READONLY },
    ],
    data,
  };
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
    programAddress: config.utxopiaProgramId,
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
    /** Token program for zkBTC mint (TOKEN_2022_PROGRAM_ID or TOKEN_PROGRAM_ID). Defaults to Token-2022. */
    tokenProgram?: Address;
    /** Consumed UTXO PDAs to close */
    consumedUtxos?: Address[];
  };
}

export interface ApproveRedemptionSigningInstructionOptions {
  /** BIP-341 taproot key-spend sighash for the unsigned BTC transaction. */
  btcSighash: Uint8Array;
  /** Optional keccak256(Sign.message), where Sign.message is the TapSighash preimage. */
  ikaMessageDigest?: Uint8Array;
  /** Miner fee in satoshis, checked by the on-chain signing policy. */
  minerFeeSats: bigint | number;
  accounts: {
    poolState: Address;
    redemptionRequest: Address;
    authority: Address;
    poolConfig: Address;
    ikaProgram: Address;
    ikaCoordinator: Address;
    ikaMessageApproval: Address;
    ikaDwallet: Address;
    callerProgram: Address;
    cpiAuthority: Address;
    ikaPayer: Address;
  };
}

export function buildApproveRedemptionSigningInstructionData(options: {
  btcSighash: Uint8Array;
  ikaMessageDigest?: Uint8Array;
  minerFeeSats: bigint | number;
}): Uint8Array {
  if (options.btcSighash.length !== 32) {
    throw new Error("btcSighash must be exactly 32 bytes");
  }
  if (options.ikaMessageDigest && options.ikaMessageDigest.length !== 32) {
    throw new Error("ikaMessageDigest must be exactly 32 bytes");
  }
  const data = new Uint8Array(1 + 32 + (options.ikaMessageDigest ? 32 : 0) + 8);
  const view = new DataView(data.buffer);
  let offset = 0;
  data[offset++] = INSTRUCTION.APPROVE_REDEMPTION_SIGNING;
  data.set(options.btcSighash, offset); offset += 32;
  if (options.ikaMessageDigest) {
    data.set(options.ikaMessageDigest, offset); offset += 32;
  }
  view.setBigUint64(offset, BigInt(options.minerFeeSats), true);
  return data;
}

export function buildApproveRedemptionSigningInstruction(
  options: ApproveRedemptionSigningInstructionOptions
): Instruction {
  const config = getConfig();
  return {
    programAddress: config.utxopiaProgramId,
    accounts: [
      { address: options.accounts.poolState, role: AccountRole.READONLY },
      { address: options.accounts.redemptionRequest, role: AccountRole.READONLY },
      { address: options.accounts.authority, role: AccountRole.READONLY_SIGNER },
      { address: options.accounts.poolConfig, role: AccountRole.READONLY },
      { address: options.accounts.ikaProgram, role: AccountRole.READONLY },
      { address: options.accounts.ikaCoordinator, role: AccountRole.READONLY },
      { address: options.accounts.ikaMessageApproval, role: AccountRole.WRITABLE },
      { address: options.accounts.ikaDwallet, role: AccountRole.READONLY },
      { address: options.accounts.callerProgram, role: AccountRole.READONLY },
      { address: options.accounts.cpiAuthority, role: AccountRole.READONLY },
      { address: options.accounts.ikaPayer, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: buildApproveRedemptionSigningInstructionData({
      btcSighash: options.btcSighash,
      ikaMessageDigest: options.ikaMessageDigest,
      minerFeeSats: options.minerFeeSats,
    }),
  };
}

/**
 * Build instruction data for COMPLETE_REDEMPTION (disc 17)
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
 * Accounts (13 base + variable):
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
 * 14..14+N consumed_utxos (writable)
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
    { address: options.accounts.tokenProgram ?? TOKEN_2022_PROGRAM_ID, role: AccountRole.READONLY },
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
    programAddress: config.utxopiaProgramId,
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
  /**
   * Optional per-output sender memos (Phase 2): 80 bytes each, layout
   * `nonce(24) || ciphertext_and_tag(56)` from `encryptSenderMemo`. Pass
   * via `packSenderMemoForInstruction` or pre-slice manually.
   */
  senderMemos?: Uint8Array[];
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
 * - n_public_outputs: u8 (always 0 for transact)
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
  /** Groth16 proof (256 bytes). Omit when using buffer mode. */
  proofBytes?: Uint8Array;
  merkleRoot: Uint8Array;
  boundParamsHash: Uint8Array;
  nullifiers: Uint8Array[];
  commitmentsOut: Uint8Array[];
  stealthData: Uint8Array[];
  /** 0=inline proof (default), 1=proof in separate ChadBuffer account */
  proofSource?: 0 | 1;
  /**
   * Optional Phase 2 sender memos — one per output. Each entry is 80 bytes:
   * `nonce(24) || ciphertext_and_tag(56)` from `encryptSenderMemo`. When
   * supplied, the program emits an EVENT_SENDER_MEMO for each output so the
   * sender can later reconstruct their outgoing history with `ovk`. Omit to
   * skip the channel entirely.
   */
  senderMemos?: Uint8Array[];
}): Uint8Array {
  const { nInputs, nOutputs, proofBytes, merkleRoot, boundParamsHash, nullifiers, commitmentsOut, stealthData, senderMemos } = options;
  const proofSource = options.proofSource ?? 0;

  if (proofSource === 0 && (!proofBytes || proofBytes.length !== 256)) {
    throw new Error(`Inline mode requires 256-byte proof, got ${proofBytes?.length ?? 0}`);
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
  const SENDER_MEMO_PER_OUTPUT = 80; // nonce(24) + ciphertext_and_tag(56)

  const hasSenderMemos = senderMemos != null;
  if (hasSenderMemos) {
    if (senderMemos!.length !== nOutputs) {
      throw new Error(`Expected ${nOutputs} sender memo entries, got ${senderMemos!.length}`);
    }
    for (let i = 0; i < senderMemos!.length; i++) {
      if (senderMemos![i].length !== SENDER_MEMO_PER_OUTPUT) {
        throw new Error(
          `Sender memo ${i} must be ${SENDER_MEMO_PER_OUTPUT} bytes; got ${senderMemos![i].length}`,
        );
      }
    }
  }

  const proofSize = proofSource === 0 ? 256 : 0;
  const senderMemosSize = hasSenderMemos ? nOutputs * SENDER_MEMO_PER_OUTPUT : 0;
  const totalSize =
    1 + 4 + proofSize + 32 + 32 + nInputs * 32 + nOutputs * 32 + nOutputs * STEALTH_DATA_PER_OUTPUT + senderMemosSize;
  const data = new Uint8Array(totalSize);

  let offset = 0;

  // Discriminator
  data[offset++] = INSTRUCTION.TRANSACT;

  // Header (4 bytes)
  data[offset++] = nInputs;
  data[offset++] = nOutputs;
  data[offset++] = 0; // n_public_outputs = 0 for transact
  data[offset++] = proofSource;

  // Proof (256 bytes, only in inline mode)
  if (proofSource === 0 && proofBytes) {
    data.set(proofBytes, offset);
    offset += 256;
  }

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

  // Optional sender memos (Phase 2): nonce(24) + ciphertext_and_tag(56) per output
  if (hasSenderMemos) {
    for (const memo of senderMemos!) {
      data.set(memo, offset);
      offset += SENDER_MEMO_PER_OUTPUT;
    }
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
    senderMemos: options.senderMemos,
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
    programAddress: config.utxopiaProgramId,
    accounts,
    data,
  };
}

// =============================================================================
// JoinSplit + BTC Redeem Instruction Builder (disc=16)
// =============================================================================

/**
 * Build instruction data for REDEEM (disc=15) — atomic JoinSplit + BTC withdrawal (multi-output)
 *
 * Combines Groth16 proof verification with RedemptionRequest PDA creation.
 * Supports 1..3 public outputs, each creating a separate RedemptionRequest.
 *
 * Layout (4-byte common header):
 * - n_inputs: u8
 * - n_outputs: u8
 * - n_public_outputs: u8 (1..3)
 * - proof_source: u8 (0=inline, 1=buffer account)
 * - proof: [u8; 256] (only if proof_source=0)
 * - merkle_root: [u8; 32]
 * - bound_params_hash: [u8; 32]
 * - nullifiers: [[u8; 32]; n_inputs]
 * - commitments_out: [[u8; 32]; n_outputs]
 * - stealth_data: [ephemeral_pub(32) + encrypted_amount(8)] x n_tree_outputs
 * - For each public output: amount(8) + script_len(1) + script(var) + nonce(8)
 */
export function buildRedeemInstructionData(options: {
  nInputs: number;
  nOutputs: number;
  /** Number of public (redeem) outputs. Defaults to 1 for backward compat. */
  nPublicOutputs?: number;
  /** Groth16 proof (256 bytes). Omit when using buffer mode. */
  proofBytes?: Uint8Array;
  merkleRoot: Uint8Array;
  boundParamsHash: Uint8Array;
  nullifiers: Uint8Array[];
  commitmentsOut: Uint8Array[];
  /** Stealth data for tree outputs only (n_tree_outputs entries, 40 bytes each) */
  stealthData: Uint8Array[];
  /** Amount(s) to redeem in satoshis — single or array */
  redeemAmounts: bigint[];
  /** Bitcoin scriptPubKey(s) (raw bytes, max 62 each) — single or array */
  btcScripts: Uint8Array[];
  /** Unique request nonce(s) — single or array */
  requestNonces: bigint[];
  /** 0=inline proof (default), 1=proof in separate ChadBuffer account */
  proofSource?: 0 | 1;
}): Uint8Array {
  const {
    nInputs, nOutputs, proofBytes, merkleRoot, boundParamsHash,
    nullifiers, commitmentsOut, stealthData, redeemAmounts, btcScripts, requestNonces,
  } = options;
  const nPublicOutputs = options.nPublicOutputs ?? redeemAmounts.length;
  const proofSource = options.proofSource ?? 0;

  if (proofSource === 0 && (!proofBytes || proofBytes.length !== 256)) {
    throw new Error(`Inline mode requires 256-byte proof, got ${proofBytes?.length ?? 0}`);
  }
  if (nPublicOutputs < 1 || nPublicOutputs > 3) {
    throw new Error(`nPublicOutputs must be 1-3, got ${nPublicOutputs}`);
  }
  const nTreeOutputs = nOutputs - nPublicOutputs;
  if (nTreeOutputs < 0) {
    throw new Error(`nOutputs (${nOutputs}) must be >= nPublicOutputs (${nPublicOutputs})`);
  }
  if (nullifiers.length !== nInputs) {
    throw new Error(`Expected ${nInputs} nullifiers, got ${nullifiers.length}`);
  }
  if (commitmentsOut.length !== nOutputs) {
    throw new Error(`Expected ${nOutputs} commitments, got ${commitmentsOut.length}`);
  }
  if (stealthData.length !== nTreeOutputs) {
    throw new Error(`Expected ${nTreeOutputs} stealth data entries, got ${stealthData.length}`);
  }
  if (redeemAmounts.length !== nPublicOutputs) {
    throw new Error(`Expected ${nPublicOutputs} redeem amounts, got ${redeemAmounts.length}`);
  }
  if (btcScripts.length !== nPublicOutputs) {
    throw new Error(`Expected ${nPublicOutputs} BTC scripts, got ${btcScripts.length}`);
  }
  if (requestNonces.length !== nPublicOutputs) {
    throw new Error(`Expected ${nPublicOutputs} request nonces, got ${requestNonces.length}`);
  }
  for (let k = 0; k < nPublicOutputs; k++) {
    if (btcScripts[k].length === 0 || btcScripts[k].length > 62) {
      throw new Error(`BTC script[${k}] must be 1-62 bytes, got ${btcScripts[k].length}`);
    }
  }

  // On-chain redeem uses 40-byte stealth data: ephemeral_pub(32) + encrypted_amount(8)
  const STEALTH_DATA_SIZE = 40;
  const proofSize = proofSource === 0 ? 256 : 0;
  let totalScriptLen = 0;
  for (const s of btcScripts) totalScriptLen += s.length;
  const totalSize = 1 + 4 + proofSize + 32 + 32
    + (nInputs * 32) + (nOutputs * 32) + (nTreeOutputs * STEALTH_DATA_SIZE)
    + nPublicOutputs * (8 + 1 + 8) + totalScriptLen;

  const data = new Uint8Array(totalSize);
  const view = new DataView(data.buffer);
  let offset = 0;

  // Discriminator
  data[offset++] = INSTRUCTION.REDEEM;

  // Header (4 bytes)
  data[offset++] = nInputs;
  data[offset++] = nOutputs;
  data[offset++] = nPublicOutputs;
  data[offset++] = proofSource;

  // Proof (256 bytes, only in inline mode)
  if (proofSource === 0 && proofBytes) {
    data.set(proofBytes, offset);
    offset += 256;
  }

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

  // Output commitments (all n_outputs, last n_public_outputs = redeem)
  for (const commitment of commitmentsOut) {
    data.set(commitment, offset);
    offset += 32;
  }

  // Stealth data for tree outputs only (40 bytes each)
  for (const sd of stealthData) {
    data.set(sd.slice(0, STEALTH_DATA_SIZE), offset);
    offset += STEALTH_DATA_SIZE;
  }

  // Per-output redeem data: amount(8) + script_len(1) + script(var) + nonce(8)
  for (let k = 0; k < nPublicOutputs; k++) {
    view.setBigUint64(offset, redeemAmounts[k], true);
    offset += 8;
    data[offset++] = btcScripts[k].length;
    data.set(btcScripts[k], offset);
    offset += btcScripts[k].length;
    view.setBigUint64(offset, requestNonces[k], true);
    offset += 8;
  }

  return data;
}

// =============================================================================
// Public Unshield Instruction Builder
// =============================================================================

/** Unshield instruction options (multi-output) */
export interface UnshieldInstructionOptions {
  /** Number of input notes being spent */
  nInputs: number;
  /** Number of output notes (includes burn outputs at end) */
  nOutputs: number;
  /** Number of public (unshield) outputs. Defaults to 1. */
  nPublicOutputs?: number;
  /** Groth16 proof bytes (256 bytes) */
  proofBytes: Uint8Array;
  /** Merkle root */
  merkleRoot: Uint8Array;
  /** Bound parameters hash */
  boundParamsHash: Uint8Array;
  /** Nullifiers (32 bytes each) */
  nullifiers: Uint8Array[];
  /** Output commitments (32 bytes each, last nPublicOutputs = burn commitments) */
  commitmentsOut: Uint8Array[];
  /** Per-output stealth data for tree outputs only */
  stealthData: Uint8Array[];
  /** Amount(s) being unshielded */
  unshieldAmounts: bigint[];
  /** Account addresses */
  accounts: {
    poolState: Address;
    commitmentTree: Address;
    vkRegistry: Address;
    user: Address;
    tokenConfig: Address;
    vault: Address;
    /** Token program for the mint (TOKEN_2022_PROGRAM_ID or TOKEN_PROGRAM_ID). Defaults to Token-2022. */
    tokenProgram?: Address;
    /** Recipient token accounts (one per public output) */
    recipientTokenAccounts: Address[];
    /** Nullifier record PDAs (one per input) */
    nullifierRecords: Address[];
  };
}

/**
 * Build unshield instruction data (multi-output, disc=14).
 *
 * Layout (4-byte common header):
 * - disc(1) + n_inputs(1) + n_outputs(1) + n_public_outputs(1) + proof_source(1)
 * - proof(256) if inline
 * - merkle_root(32) + bound_params_hash(32)
 * - nullifiers(N*32) + commitments_out(M*32)
 * - stealth_data(n_tree_outputs * 72)
 * - amounts[P] (each u64 LE)
 *
 * Recipients come from accounts array (one token account per public output).
 */
export function buildUnshieldInstructionData(options: {
  nInputs: number;
  nOutputs: number;
  /** Number of public (unshield) outputs. Defaults to 1. */
  nPublicOutputs?: number;
  /** Groth16 proof (256 bytes). Omit when using buffer mode. */
  proofBytes?: Uint8Array;
  merkleRoot: Uint8Array;
  boundParamsHash: Uint8Array;
  nullifiers: Uint8Array[];
  commitmentsOut: Uint8Array[];
  stealthData: Uint8Array[];
  /** Amount(s) being unshielded — single or array */
  unshieldAmounts: bigint[];
  /** 0=inline proof (default), 1=proof in separate ChadBuffer account */
  proofSource?: 0 | 1;
}): Uint8Array {
  const { nInputs, nOutputs, proofBytes, merkleRoot, boundParamsHash, nullifiers, commitmentsOut, stealthData, unshieldAmounts } = options;
  const nPublicOutputs = options.nPublicOutputs ?? unshieldAmounts.length;
  const proofSource = options.proofSource ?? 0;

  if (proofSource === 0 && (!proofBytes || proofBytes.length !== 256)) {
    throw new Error(`Inline mode requires 256-byte proof, got ${proofBytes?.length ?? 0}`);
  }
  if (nPublicOutputs < 1 || nPublicOutputs > 3) {
    throw new Error(`nPublicOutputs must be 1-3, got ${nPublicOutputs}`);
  }
  if (nullifiers.length !== nInputs) {
    throw new Error(`Expected ${nInputs} nullifiers, got ${nullifiers.length}`);
  }
  if (commitmentsOut.length !== nOutputs) {
    throw new Error(`Expected ${nOutputs} commitments, got ${commitmentsOut.length}`);
  }
  const nTreeOutputs = nOutputs - nPublicOutputs;
  if (nTreeOutputs < 0) {
    throw new Error(`nOutputs (${nOutputs}) must be >= nPublicOutputs (${nPublicOutputs})`);
  }
  if (stealthData.length !== nTreeOutputs) {
    throw new Error(`Expected ${nTreeOutputs} stealth data entries (tree outputs), got ${stealthData.length}`);
  }
  if (unshieldAmounts.length !== nPublicOutputs) {
    throw new Error(`Expected ${nPublicOutputs} unshield amounts, got ${unshieldAmounts.length}`);
  }

  const STEALTH_DATA_PER_OUTPUT = 72; // ephemeral_pub(32) + encrypted_amount(8) + encrypted_token_id(32)
  const proofSize = proofSource === 0 ? 256 : 0;
  const totalSize = 1 + 4 + proofSize + 32 + 32 + (nInputs * 32) + (nOutputs * 32) + (nTreeOutputs * STEALTH_DATA_PER_OUTPUT) + (nPublicOutputs * 8);
  const data = new Uint8Array(totalSize);
  const view = new DataView(data.buffer);

  let offset = 0;

  // Discriminator
  data[offset++] = INSTRUCTION.UNSHIELD;

  // Header (4 bytes)
  data[offset++] = nInputs;
  data[offset++] = nOutputs;
  data[offset++] = nPublicOutputs;
  data[offset++] = proofSource;

  // Proof (256 bytes, only in inline mode)
  if (proofSource === 0 && proofBytes) {
    data.set(proofBytes, offset);
    offset += 256;
  }

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

  // Output commitments (all n_outputs, last nPublicOutputs = burn)
  for (const commitment of commitmentsOut) {
    data.set(commitment, offset);
    offset += 32;
  }

  // Stealth data for tree outputs only
  for (const sd of stealthData) {
    data.set(sd.slice(0, STEALTH_DATA_PER_OUTPUT), offset);
    offset += STEALTH_DATA_PER_OUTPUT;
  }

  // Per-output unshield amounts (u64 LE each)
  for (const amount of unshieldAmounts) {
    view.setBigUint64(offset, amount, true);
    offset += 8;
  }

  return data;
}

/**
 * Build a complete unshield instruction (multi-output, disc=14)
 *
 * Accounts:
 * 0. pool_state (read)
 * 1. commitment_tree (writable)
 * 2. vk_registry (read)
 * 3. user (signer)
 * 4. system_program (read)
 * 5. token_config (writable)
 * 6. vault (writable)
 * 7. token_program (read)
 * 8..8+P recipient_token_accounts (writable, one per public output)
 * 8+P..8+P+N nullifier_records (writable)
 */
export function buildUnshieldInstruction(options: UnshieldInstructionOptions): Instruction {
  const config = getConfig();
  const nPublicOutputs = options.nPublicOutputs ?? options.unshieldAmounts.length;

  const data = buildUnshieldInstructionData({
    nInputs: options.nInputs,
    nOutputs: options.nOutputs,
    nPublicOutputs,
    proofBytes: options.proofBytes,
    merkleRoot: options.merkleRoot,
    boundParamsHash: options.boundParamsHash,
    nullifiers: options.nullifiers,
    commitmentsOut: options.commitmentsOut,
    stealthData: options.stealthData,
    unshieldAmounts: options.unshieldAmounts,
  });

  const accounts: Instruction["accounts"] = [
    { address: options.accounts.poolState, role: AccountRole.READONLY },
    { address: options.accounts.commitmentTree, role: AccountRole.WRITABLE },
    { address: options.accounts.vkRegistry, role: AccountRole.READONLY },
    { address: options.accounts.user, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: options.accounts.tokenConfig, role: AccountRole.WRITABLE },
    { address: options.accounts.vault, role: AccountRole.WRITABLE },
    { address: options.accounts.tokenProgram ?? TOKEN_2022_PROGRAM_ID, role: AccountRole.READONLY },
  ];

  // Recipient token accounts (one per public output)
  for (const rta of options.accounts.recipientTokenAccounts) {
    accounts.push({ address: rta, role: AccountRole.WRITABLE });
  }

  // Nullifier records (writable PDAs)
  for (const nr of options.accounts.nullifierRecords) {
    accounts.push({ address: nr, role: AccountRole.WRITABLE });
  }

  return {
    programAddress: config.utxopiaProgramId,
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
    programAddress: config.utxopiaProgramId,
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
    programAddress: config.utxopiaProgramId,
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
    programAddress: config.utxopiaProgramId,
    accounts: [
      { address: options.accounts.poolState, role: AccountRole.WRITABLE },
      { address: options.accounts.authority, role: AccountRole.WRITABLE_SIGNER },
    ],
    data: buildCancelPoolUpdateInstructionData(),
  };
}

// =============================================================================
// Rotate Tree Instruction Builder (disc=20)
// =============================================================================

/** Rotate tree instruction options */
export interface RotateTreeOptions {
  accounts: {
    poolState: Address;
    currentTree: Address;
    newTree: Address;
    authority: Address;
    systemProgram: Address;
  };
}

/**
 * Build rotate_tree instruction data (disc=20, no payload)
 */
export function buildRotateTreeInstructionData(): Uint8Array {
  return new Uint8Array([INSTRUCTION.ROTATE_TREE]);
}

/**
 * Build a complete rotate_tree instruction
 *
 * Accounts:
 * 0. pool_state    (writable)
 * 1. current_tree  (writable) — must be full
 * 2. new_tree      (writable) — to be created
 * 3. authority     (signer)
 * 4. system_program
 */
export function buildRotateTreeInstruction(options: RotateTreeOptions): Instruction {
  const config = getConfig();

  return {
    programAddress: config.utxopiaProgramId,
    accounts: [
      { address: options.accounts.poolState, role: AccountRole.WRITABLE },
      { address: options.accounts.currentTree, role: AccountRole.WRITABLE },
      { address: options.accounts.newTree, role: AccountRole.WRITABLE },
      { address: options.accounts.authority, role: AccountRole.WRITABLE_SIGNER },
      { address: options.accounts.systemProgram, role: AccountRole.READONLY },
    ],
    data: buildRotateTreeInstructionData(),
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
// BTC Light Client Verify Transaction (disc=2)
// =============================================================================

/**
 * Build btc-light-client verify_transaction instruction data (disc=2)
 *
 * Layout (after disc byte):
 * txid(32) + block_hash(32) + tx_size(u32 LE) + merkle_proof(variable)
 *
 * Merkle proof sub-layout:
 * proof_txid(32) + path_bits(u32 LE) + path_len(u8) + tx_index(u32 LE) + siblings(32 * path_len)
 */
export function buildVerifyTransactionInstructionData(params: {
  txid: Uint8Array;        // 32 bytes, internal byte order
  blockHash: Uint8Array;   // 32 bytes
  txSize: number;          // raw tx size in ChadBuffer (after 32-byte authority)
  txIndex: number;
  merkleSiblings: Uint8Array[]; // each 32 bytes, internal byte order
  pathBits: number;        // bitmask of path direction
}): Uint8Array {
  const { txid, blockHash, txSize, txIndex, merkleSiblings, pathBits } = params;
  const pathLen = merkleSiblings.length;

  // disc(1) + txid(32) + blockHash(32) + txSize(4) + proofTxid(32) + pathBits(4) + pathLen(1) + txIndex(4) + siblings(32*N)
  const totalSize = 1 + 32 + 32 + 4 + 32 + 4 + 1 + 4 + 32 * pathLen;
  const data = new Uint8Array(totalSize);
  const view = new DataView(data.buffer);
  let offset = 0;

  data[offset++] = 2; // discriminator for verify_transaction
  data.set(txid, offset); offset += 32;
  data.set(blockHash, offset); offset += 32;
  view.setUint32(offset, txSize, true); offset += 4;

  // Merkle proof sub-layout
  data.set(txid, offset); offset += 32; // proof_txid = txid
  view.setUint32(offset, pathBits, true); offset += 4;
  data[offset++] = pathLen;
  view.setUint32(offset, txIndex, true); offset += 4;
  for (const sibling of merkleSiblings) {
    data.set(sibling, offset); offset += 32;
  }

  return data;
}

// =============================================================================
// UTXOpia Verify Stealth Deposit (disc=11)
// =============================================================================

/**
 * Build utxopia complete_deposit instruction data (disc=11)
 *
 * npk + ephemeral_pub are extracted ON-CHAIN from the deposit TX OP_RETURN.
 * Amount is extracted from the SPV-verified sweep TX.
 *
 * Layout: disc(1) + sweep_txid(32) + block_height(u64 LE)
 *         + sweep_tx_size(u32 LE) + deposit_tx_size(u32 LE) + deposit_txid(32) = 81 bytes
 */
export function buildVerifyStealthDepositInstructionData(params: {
  sweepTxid: Uint8Array;      // 32 bytes, internal byte order
  blockHeight: number;
  sweepTxSize: number;
  depositTxSize: number;
  depositTxid: Uint8Array;    // 32 bytes, internal byte order
}): Uint8Array {
  const data = new Uint8Array(81);
  const view = new DataView(data.buffer);
  let offset = 0;

  data[offset++] = INSTRUCTION.COMPLETE_DEPOSIT;
  data.set(params.sweepTxid, offset); offset += 32;
  view.setBigUint64(offset, BigInt(params.blockHeight), true); offset += 8;
  view.setUint32(offset, params.sweepTxSize, true); offset += 4;
  view.setUint32(offset, params.depositTxSize, true); offset += 4;
  data.set(params.depositTxid, offset); offset += 32;

  return data;
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
