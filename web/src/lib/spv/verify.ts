/**
 * SPV Verification Client
 *
 * Submits block headers and verifies deposits on Solana
 */

import { Connection, PublicKey } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  getSPVProofData,
  reverseBytes,
  type BlockHeader,
  type MerkleProof,
} from "./mempool";
import { hexToBytes } from "@privacy-coin/sdk";

// BTC Light Client Program ID — uses env var, falls back to devnet for dev
const BTC_LIGHT_CLIENT_ID = new PublicKey(
  process.env.NEXT_PUBLIC_BTC_LIGHT_CLIENT_PROGRAM_ID || "Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq"
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
  programId: PublicKey = BTC_LIGHT_CLIENT_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("btc_light_client")],
    programId
  );
}

/**
 * Derive PDA for block header (keyed by block hash in internal byte order)
 */
export function deriveBlockHeaderPDA(
  blockHash: Uint8Array,
  programId: PublicKey = BTC_LIGHT_CLIENT_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("block"), Buffer.from(blockHash)],
    programId
  );
}

/**
 * Derive PDA for height index (keyed by block height)
 */
export function deriveHeightIndexPDA(
  blockHeight: number,
  programId: PublicKey = BTC_LIGHT_CLIENT_ID
): [PublicKey, number] {
  const heightBuffer = Buffer.alloc(8);
  heightBuffer.writeBigUInt64LE(BigInt(blockHeight));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("height_index"), heightBuffer],
    programId
  );
}

/**
 * Check if a block header exists on-chain at the given height
 */
export async function checkBlockHeaderExists(
  connection: Connection,
  blockHeight: number,
  programId: PublicKey = BTC_LIGHT_CLIENT_ID
): Promise<boolean> {
  const [heightIndexPDA] = deriveHeightIndexPDA(blockHeight, programId);
  const accountInfo = await connection.getAccountInfo(heightIndexPDA);
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
 * Submit on-chain SPV verification via the /api/verify endpoint.
 *
 * The endpoint handles:
 * 1. Fetching raw tx from mempool.space
 * 2. Uploading to ChadBuffer
 * 3. Building verify_transaction + verify_stealth_deposit instructions
 * 4. Submitting and confirming on Solana
 */
export async function submitSPVVerification(
  _connection: Connection,
  _wallet: WalletContextState,
  spvData: SPVVerifyResult,
  expectedAmountSats: number,
  _commitmentBytes: Uint8Array,
  ephemeralPub?: string,
  npk?: string,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  if (!ephemeralPub || !npk) {
    return { success: false, error: "ephemeralPub and npk are required for verification" };
  }

  try {
    const response = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sweepTxid: spvData.txid,
        blockHeight: spvData.blockHeight,
        amountSats: expectedAmountSats,
        ephemeralPub,
        npk,
      }),
    });

    const result = await response.json();

    if (!result.success) {
      return { success: false, error: result.error || "Verification failed" };
    }

    return {
      success: true,
      signature: result.signature,
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
