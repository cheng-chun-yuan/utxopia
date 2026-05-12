/**
 * PDA (Program Derived Address) Derivation Utilities
 *
 * Centralized module for all UTXOpia PDA derivations.
 * Prevents code duplication across api.ts, pda.ts, etc.
 *
 * NOTE: Program IDs are defined in config.ts and re-exported here
 * for backwards compatibility. Use config.ts for all new code.
 *
 * @module pda
 */

import {
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";

// Import program IDs from config for local use
import {
  UTXOPIA_PROGRAM_ID as _UTXOPIA_PROGRAM_ID,
  BTC_LIGHT_CLIENT_PROGRAM_ID as _BTC_LIGHT_CLIENT_PROGRAM_ID,
} from "./config";

// Re-export everything from config for backwards compatibility
export {
  UTXOPIA_PROGRAM_ID,
  BTC_LIGHT_CLIENT_PROGRAM_ID,
  getConfig,
  setConfig,
  initConfig,
  DEVNET_CONFIG,
  MAINNET_CONFIG,
  LOCALNET_CONFIG,
  type NetworkConfig,
  type NetworkType,
} from "./config";

// Local aliases for use in this file
const UTXOPIA_PROGRAM_ID = _UTXOPIA_PROGRAM_ID;
const BTC_LIGHT_CLIENT_PROGRAM_ID = _BTC_LIGHT_CLIENT_PROGRAM_ID;

// =============================================================================
// PDA Seeds
// =============================================================================

export const PDA_SEEDS = {
  POOL_STATE: "pool_state",
  COMMITMENT_TREE: "commitment_tree",
  LIGHT_CLIENT: "btc_light_client",
  BLOCK_HEADER: "block",
  HEIGHT_INDEX: "height_index",
  VERIFIED_TX: "verified_tx",
  DEPOSIT: "deposit",
  NULLIFIER: "nullifier",
  VK_REGISTRY: "vk_registry",
  TOKEN_CONFIG: "token_config",
} as const;

// =============================================================================
// Core UTXOpia PDAs
// =============================================================================

/**
 * Derive Pool State PDA
 */
export async function derivePoolStatePDA(
  programId: Address = UTXOPIA_PROGRAM_ID
): Promise<[Address, number]> {
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(PDA_SEEDS.POOL_STATE)],
  });
  return [result[0], result[1]];
}

/**
 * Derive Commitment Tree PDA
 *
 * @param treeIndex - Tree rotation index (default 0). When undefined or 0,
 *   uses the legacy seed for backward compatibility.
 */
export async function deriveCommitmentTreePDA(
  programId: Address = UTXOPIA_PROGRAM_ID,
  treeIndex?: number,
): Promise<[Address, number]> {
  // Legacy seed for tree 0 (backward compat with existing deployments)
  if (treeIndex === undefined || treeIndex === 0) {
    const result = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [new TextEncoder().encode(PDA_SEEDS.COMMITMENT_TREE)],
    });
    return [result[0], result[1]];
  }

  // Indexed seed for rotated trees
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, treeIndex, true);
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(PDA_SEEDS.COMMITMENT_TREE), indexBytes],
  });
  return [result[0], result[1]];
}

/**
 * Derive TokenConfig PDA for a specific mint
 * Seeds: ["token_config", mint_pubkey_bytes]
 */
export async function deriveTokenConfigPDA(
  mintPubkey: Uint8Array,
  programId: Address = UTXOPIA_PROGRAM_ID
): Promise<[Address, number]> {
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(PDA_SEEDS.TOKEN_CONFIG), mintPubkey],
  });
  return [result[0], result[1]];
}

/**
 * Derive Nullifier Record PDA
 */
export async function deriveNullifierRecordPDA(
  nullifierHash: Uint8Array,
  programId: Address = UTXOPIA_PROGRAM_ID
): Promise<[Address, number]> {
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(PDA_SEEDS.NULLIFIER), nullifierHash],
  });
  return [result[0], result[1]];
}

// =============================================================================
// BTC Light Client PDAs
// =============================================================================

/**
 * Derive BTC Light Client PDA
 */
export async function deriveLightClientPDA(
  programId: Address = BTC_LIGHT_CLIENT_PROGRAM_ID
): Promise<[Address, number]> {
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(PDA_SEEDS.LIGHT_CLIENT)],
  });
  return [result[0], result[1]];
}

/**
 * Derive Block Header PDA (hash-based)
 * Seeds: ["block", blockHash(32)]
 */
export async function deriveBlockHeaderPDA(
  blockHash: Uint8Array,
  programId: Address = BTC_LIGHT_CLIENT_PROGRAM_ID
): Promise<[Address, number]> {
  if (blockHash.length !== 32) {
    throw new Error(`blockHash must be 32 bytes, got ${blockHash.length}`);
  }
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(PDA_SEEDS.BLOCK_HEADER), blockHash],
  });
  return [result[0], result[1]];
}

/**
 * Derive HeightIndex PDA
 * Seeds: ["height_index", height_le_bytes(8)]
 */
export async function deriveHeightIndexPDA(
  height: number | bigint,
  programId: Address = BTC_LIGHT_CLIENT_PROGRAM_ID
): Promise<[Address, number]> {
  const heightBuffer = new Uint8Array(8);
  const view = new DataView(heightBuffer.buffer);
  view.setBigUint64(0, BigInt(height), true);
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(PDA_SEEDS.HEIGHT_INDEX), heightBuffer],
  });
  return [result[0], result[1]];
}

/**
 * Derive VerifiedTransaction PDA (btc-light-client)
 *
 * Seeds: ["verified_tx", blockHash(32), txid(32)]
 */
export async function deriveVerifiedTransactionPDA(
  blockHash: Uint8Array,
  txid: Uint8Array,
  programId: Address = BTC_LIGHT_CLIENT_PROGRAM_ID
): Promise<[Address, number]> {
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(PDA_SEEDS.VERIFIED_TX), blockHash, txid],
  });
  return [result[0], result[1]];
}

// =============================================================================
// Redemption Request PDAs
// =============================================================================

/**
 * Derive Redemption Request PDA
 *
 * Seeds: ["redemption", user_pubkey(32), nonce_le(8)]
 */
export async function deriveRedemptionRequestPDA(
  userPubkey: Uint8Array,
  nonce: bigint,
  programId: Address = UTXOPIA_PROGRAM_ID
): Promise<[Address, number]> {
  const nonceBytes = new Uint8Array(8);
  const view = new DataView(nonceBytes.buffer);
  view.setBigUint64(0, nonce, true);

  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode("redemption"), userPubkey, nonceBytes],
  });
  return [result[0], result[1]];
}

// =============================================================================
// VK Registry PDAs
// =============================================================================

/**
 * Derive VK Registry PDA for a JoinSplit variant
 *
 * Seeds: ["vk_registry", &[n_inputs], &[n_outputs]]
 */
export async function deriveVkRegistryPDA(
  nInputs: number,
  nOutputs: number,
  programId: Address = UTXOPIA_PROGRAM_ID
): Promise<[Address, number]> {
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      new TextEncoder().encode(PDA_SEEDS.VK_REGISTRY),
      new Uint8Array([nInputs]),
      new Uint8Array([nOutputs]),
    ],
  });
  return [result[0], result[1]];
}

// =============================================================================
// Deposit Receipt PDAs
// =============================================================================

/**
 * Derive Deposit Receipt PDA
 * Seeds: ["deposit_receipt", deposit_txid(32)]
 */
export async function deriveDepositReceiptPDA(
  depositTxid: Uint8Array,
  programId: Address = UTXOPIA_PROGRAM_ID
): Promise<[Address, number]> {
  if (depositTxid.length !== 32) {
    throw new Error(`depositTxid must be 32 bytes, got ${depositTxid.length}`);
  }
  const result = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode("deposit_receipt"), depositTxid],
  });
  return [result[0], result[1]];
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Convert bigint commitment to bytes for PDA derivation
 */
export function commitmentToBytes(commitment: bigint): Uint8Array {
  const hex = commitment.toString(16).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
