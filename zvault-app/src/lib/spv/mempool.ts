/**
 * Mempool.space API helpers for SPV verification
 *
 * Re-exports SDK's MempoolClient with backward-compatible function wrappers.
 */

import {
  MempoolClient,
  mempoolTestnet,
  mempoolMainnet,
  reverseBytes as sdkReverseBytes,
  type BlockHeader as SdkBlockHeader,
  type TransactionInfo as SdkTransactionInfo,
} from "@zvault/sdk";

// Re-export SDK types and utilities
export type BlockHeader = SdkBlockHeader;
export type TransactionInfo = SdkTransactionInfo;
export { MempoolClient, mempoolTestnet, mempoolMainnet };
export { hexToBytes, bytesToHex } from "@zvault/sdk";
export const reverseBytes = sdkReverseBytes;

// Local interface for merkle proof (matches original API)
export interface MerkleProof {
  blockHeight: number;
  blockHash: string;
  txIndex: number;
  merkleProof: string[];
}

// Cache clients per network
const clients: Record<string, MempoolClient> = {};

function getClient(network: "mainnet" | "testnet"): MempoolClient {
  if (!clients[network]) {
    clients[network] = new MempoolClient(network);
  }
  return clients[network];
}

/**
 * Get transaction info including block hash
 */
export async function getTransactionInfo(
  txid: string,
  network: "mainnet" | "testnet" = "testnet"
): Promise<TransactionInfo> {
  const client = getClient(network);
  return client.getTransactionInfo(txid);
}

/**
 * Get block header by hash
 */
export async function getBlockHeader(
  blockHash: string,
  network: "mainnet" | "testnet" = "testnet"
): Promise<BlockHeader> {
  const client = getClient(network);
  return client.getBlockHeaderFull(blockHash);
}

/**
 * Get block header by height
 */
export async function getBlockHeaderByHeight(
  height: number,
  network: "mainnet" | "testnet" = "testnet"
): Promise<BlockHeader> {
  const client = getClient(network);
  return client.getBlockHeaderByHeight(height);
}

/**
 * Get merkle proof for a transaction
 */
export async function getMerkleProof(
  txid: string,
  network: "mainnet" | "testnet" = "testnet"
): Promise<MerkleProof> {
  const client = getClient(network);
  const proof = await client.getTxMerkleProof(txid);
  return {
    blockHeight: proof.block_height,
    blockHash: "", // Not provided by this endpoint
    txIndex: proof.pos,
    merkleProof: proof.merkle,
  };
}

/**
 * Get current blockchain tip height
 */
export async function getTipHeight(
  network: "mainnet" | "testnet" = "testnet"
): Promise<number> {
  const client = getClient(network);
  return client.getBlockHeight();
}

/**
 * Get all data needed for SPV verification
 */
export async function getSPVProofData(
  txid: string,
  network: "mainnet" | "testnet" = "testnet"
): Promise<{
  txInfo: TransactionInfo;
  blockHeader: BlockHeader;
  merkleProof: MerkleProof;
  confirmations: number;
}> {
  const client = getClient(network);
  const spvData = await client.getSPVProofData(txid);

  return {
    txInfo: spvData.txInfo,
    blockHeader: spvData.blockHeader,
    merkleProof: {
      blockHeight: spvData.merkleProof.block_height,
      blockHash: spvData.merkleProof.blockHash,
      txIndex: spvData.merkleProof.pos,
      merkleProof: spvData.merkleProof.merkle,
    },
    confirmations: spvData.confirmations,
  };
}
