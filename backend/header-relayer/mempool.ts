/**
 * Bitcoin API client using mempool.space
 *
 * Supports mainnet, testnet3, testnet4, signet, and regtest networks.
 */

export type BitcoinNetwork = 'mainnet' | 'testnet' | 'testnet4' | 'signet' | 'regtest';

function getBaseUrl(network: BitcoinNetwork, apiUrlOverride?: string): string {
  // Allow override via BITCOIN_API_URL (for regtest Esplora proxy)
  const override = apiUrlOverride || process.env.BITCOIN_API_URL;
  if (override) return override;

  switch (network) {
    case 'mainnet':
      return 'https://mempool.space/api';
    case 'testnet':
      return 'https://mempool.space/testnet/api';
    case 'testnet4':
      return 'https://mempool.space/testnet4/api';
    case 'signet':
      return 'https://mempool.space/signet/api';
    case 'regtest':
      return 'http://localhost:2140';
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
}

/**
 * Get current Bitcoin chain tip height
 */
export async function getTipHeight(network: BitcoinNetwork): Promise<number> {
  const baseUrl = getBaseUrl(network);
  const res = await fetch(`${baseUrl}/blocks/tip/height`);

  if (!res.ok) {
    throw new Error(`Failed to get tip height: ${res.status} ${res.statusText}`);
  }

  const height = await res.text();
  return parseInt(height, 10);
}

/**
 * Get block hash at a specific height
 */
export async function getBlockHashByHeight(
  network: BitcoinNetwork,
  height: number
): Promise<string> {
  const baseUrl = getBaseUrl(network);
  const res = await fetch(`${baseUrl}/block-height/${height}`);

  if (!res.ok) {
    throw new Error(`Failed to get block hash at height ${height}: ${res.status} ${res.statusText}`);
  }

  return await res.text();
}

/**
 * Get raw block header (80 bytes) as hex string
 */
export async function getBlockHeaderHex(
  network: BitcoinNetwork,
  blockHash: string
): Promise<string> {
  const baseUrl = getBaseUrl(network);
  const res = await fetch(`${baseUrl}/block/${blockHash}/header`);

  if (!res.ok) {
    throw new Error(`Failed to get block header ${blockHash}: ${res.status} ${res.statusText}`);
  }

  return await res.text();
}

/**
 * Get raw 80-byte block header by height
 */
export async function getBlockHeaderByHeight(
  network: BitcoinNetwork,
  height: number
): Promise<Uint8Array> {
  const blockHash = await getBlockHashByHeight(network, height);
  const headerHex = await getBlockHeaderHex(network, blockHash);

  // Convert hex to Uint8Array
  const header = new Uint8Array(80);
  for (let i = 0; i < 80; i++) {
    header[i] = parseInt(headerHex.slice(i * 2, i * 2 + 2), 16);
  }

  return header;
}

/**
 * Get block details (for debugging/logging)
 */
export interface BlockInfo {
  id: string;
  height: number;
  version: number;
  timestamp: number;
  bits: number;
  nonce: number;
  difficulty: number;
  merkle_root: string;
  previousblockhash: string;
}

export async function getBlockInfo(
  network: BitcoinNetwork,
  blockHash: string
): Promise<BlockInfo> {
  const baseUrl = getBaseUrl(network);
  const res = await fetch(`${baseUrl}/block/${blockHash}`);

  if (!res.ok) {
    throw new Error(`Failed to get block info ${blockHash}: ${res.status} ${res.statusText}`);
  }

  return await res.json();
}

/**
 * Get block info by height (convenience method)
 */
export async function getBlockInfoByHeight(
  network: BitcoinNetwork,
  height: number
): Promise<BlockInfo> {
  const blockHash = await getBlockHashByHeight(network, height);
  return await getBlockInfo(network, blockHash);
}
