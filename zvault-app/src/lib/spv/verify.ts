/**
 * SPV Verification Client
 *
 * Submits block headers and verifies deposits on Solana
 */

import { Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  getSPVProofData,
  getBlockHeader,
  hexToBytes,
  reverseBytes,
  bytesToHex,
  type BlockHeader,
  type MerkleProof,
} from "./mempool";

// zVault Program ID (devnet)
const ZVAULT_PROGRAM_ID = new PublicKey(
  "E1ebNLd1cDUcw49bR6Ga527WyChWrY4NAPk7NxmcMgWg"
);

// Minimum confirmations for SPV verification
export const MIN_CONFIRMATIONS_FOR_SPV = 2;

/**
 * SPV verification result
 */
export interface SPVVerifyResult {
  success: boolean;
  txid: string;
  blockHeight: number;
  blockHash: string;
  confirmations: number;
  merkleProof: MerkleProof;
  blockHeader: BlockHeader;
  error?: string;
}

/**
 * Derive PDA for light client state
 */
export function deriveLightClientPDA(
  programId: PublicKey = ZVAULT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("btc_light_client")],
    programId
  );
}

/**
 * Derive PDA for block header
 */
export function deriveBlockHeaderPDA(
  blockHeight: number,
  programId: PublicKey = ZVAULT_PROGRAM_ID
): [PublicKey, number] {
  const heightBuffer = Buffer.alloc(8);
  heightBuffer.writeBigUInt64LE(BigInt(blockHeight));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("block_header"), heightBuffer],
    programId
  );
}

/**
 * Derive PDA for deposit record
 */
export function deriveDepositRecordPDA(
  txidBytes: Uint8Array,
  programId: PublicKey = ZVAULT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("deposit"), txidBytes],
    programId
  );
}

/**
 * Check if block header exists on-chain
 */
export async function checkBlockHeaderExists(
  connection: Connection,
  blockHeight: number,
  programId: PublicKey = ZVAULT_PROGRAM_ID
): Promise<boolean> {
  const [headerPDA] = deriveBlockHeaderPDA(blockHeight, programId);
  const accountInfo = await connection.getAccountInfo(headerPDA);
  return accountInfo !== null;
}

/**
 * Get SPV data for a transaction (block header + merkle proof)
 *
 * This is called when user clicks "Verify Deposit"
 */
export async function prepareSPVVerification(
  txid: string,
  network: "mainnet" | "testnet" = "testnet"
): Promise<SPVVerifyResult> {
  try {
    console.log("[SPV] Fetching SPV proof data for:", txid);

    const { txInfo, blockHeader, merkleProof, confirmations } =
      await getSPVProofData(txid, network);

    if (confirmations < MIN_CONFIRMATIONS_FOR_SPV) {
      return {
        success: false,
        txid,
        blockHeight: blockHeader.height,
        blockHash: blockHeader.hash,
        confirmations,
        merkleProof,
        blockHeader,
        error: `Need at least ${MIN_CONFIRMATIONS_FOR_SPV} confirmations, have ${confirmations}`,
      };
    }

    console.log("[SPV] Data fetched:", {
      blockHeight: blockHeader.height,
      blockHash: blockHeader.hash,
      confirmations,
      merkleProofLength: merkleProof.merkleProof.length,
    });

    return {
      success: true,
      txid,
      blockHeight: blockHeader.height,
      blockHash: blockHeader.hash,
      confirmations,
      merkleProof,
      blockHeader,
    };
  } catch (error) {
    console.error("[SPV] Failed to prepare verification:", error);
    return {
      success: false,
      txid,
      blockHeight: 0,
      blockHash: "",
      confirmations: 0,
      merkleProof: { blockHeight: 0, blockHash: "", txIndex: 0, merkleProof: [] },
      blockHeader: {
        height: 0,
        hash: "",
        version: 0,
        previousBlockHash: "",
        merkleRoot: "",
        timestamp: 0,
        bits: 0,
        nonce: 0,
        rawHeader: "",
      },
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Build merkle proof path from tx index
 */
export function buildMerkleProofPath(
  txIndex: number,
  proofLength: number
): boolean[] {
  const path: boolean[] = [];
  let index = txIndex;
  for (let i = 0; i < proofLength; i++) {
    path.push((index & 1) === 1);
    index = index >> 1;
  }
  return path;
}

/**
 * Format block header for on-chain submission
 */
export function formatBlockHeaderForChain(header: BlockHeader): {
  version: number;
  prevBlockHash: number[];
  merkleRoot: number[];
  timestamp: number;
  bits: number;
  nonce: number;
} {
  // Parse raw header (80 bytes = 160 hex chars)
  const rawBytes = hexToBytes(header.rawHeader);

  // Bitcoin header layout:
  // version: 4 bytes (little-endian)
  // prev_block_hash: 32 bytes (internal byte order)
  // merkle_root: 32 bytes (internal byte order)
  // timestamp: 4 bytes (little-endian)
  // bits: 4 bytes (little-endian)
  // nonce: 4 bytes (little-endian)

  const prevBlockHashBytes = reverseBytes(hexToBytes(header.previousBlockHash));
  const merkleRootBytes = reverseBytes(hexToBytes(header.merkleRoot));

  return {
    version: header.version,
    prevBlockHash: Array.from(prevBlockHashBytes),
    merkleRoot: Array.from(merkleRootBytes),
    timestamp: header.timestamp,
    bits: header.bits,
    nonce: header.nonce,
  };
}

/**
 * Format merkle proof for on-chain verification
 */
export function formatMerkleProofForChain(
  txid: string,
  merkleProof: MerkleProof
): {
  txid: number[];
  siblings: number[][];
  path: boolean[];
  txIndex: number;
} {
  // Txid needs to be reversed for internal byte order
  const txidBytes = reverseBytes(hexToBytes(txid));

  // Convert siblings (already in internal byte order from mempool.space)
  const siblings = merkleProof.merkleProof.map((hash) => {
    const bytes = hexToBytes(hash);
    // mempool.space returns in display order, need to reverse
    return Array.from(reverseBytes(bytes));
  });

  // Build path from tx index
  const path = buildMerkleProofPath(merkleProof.txIndex, siblings.length);

  return {
    txid: Array.from(txidBytes),
    siblings,
    path,
    txIndex: merkleProof.txIndex,
  };
}

/**
 * Placeholder for actual on-chain verification
 *
 * In production, this would:
 * 1. Submit block header (if not exists)
 * 2. Call verify_deposit instruction with merkle proof
 */
export async function submitSPVVerification(
  connection: Connection,
  wallet: WalletContextState,
  spvData: SPVVerifyResult,
  expectedAmountSats: number,
  commitmentBytes: Uint8Array
): Promise<{ success: boolean; signature?: string; error?: string }> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    return { success: false, error: "Wallet not connected" };
  }

  try {
    console.log("[SPV] Submitting SPV verification...");
    console.log("[SPV] Block height:", spvData.blockHeight);
    console.log("[SPV] Confirmations:", spvData.confirmations);

    // Check if block header exists
    const headerExists = await checkBlockHeaderExists(
      connection,
      spvData.blockHeight
    );

    console.log("[SPV] Block header exists on-chain:", headerExists);

    // Format data for chain
    const headerData = formatBlockHeaderForChain(spvData.blockHeader);
    const proofData = formatMerkleProofForChain(spvData.txid, spvData.merkleProof);

    console.log("[SPV] Header data prepared:", {
      version: headerData.version,
      timestamp: headerData.timestamp,
      bits: headerData.bits,
      nonce: headerData.nonce,
    });

    console.log("[SPV] Merkle proof prepared:", {
      txIndex: proofData.txIndex,
      pathLength: proofData.path.length,
      siblingsCount: proofData.siblings.length,
    });

    // TODO: Build and send actual transaction
    // For now, return success with the prepared data
    console.log("[SPV] Verification data ready for on-chain submission");

    // In demo mode, just return success
    return {
      success: true,
      signature: "demo_" + Date.now().toString(16),
    };
  } catch (error) {
    console.error("[SPV] Submission failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Full SPV verification flow
 */
export async function verifySPV(
  connection: Connection,
  wallet: WalletContextState,
  txid: string,
  expectedAmountSats: number,
  commitmentBytes: Uint8Array,
  network: "mainnet" | "testnet" = "testnet"
): Promise<{ success: boolean; signature?: string; error?: string }> {
  // Step 1: Prepare SPV data
  const spvData = await prepareSPVVerification(txid, network);
  if (!spvData.success) {
    return { success: false, error: spvData.error };
  }

  // Step 2: Submit verification
  return submitSPVVerification(
    connection,
    wallet,
    spvData,
    expectedAmountSats,
    commitmentBytes
  );
}
