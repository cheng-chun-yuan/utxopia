/**
 * Esplora Client - Platform-agnostic HTTP client for Bitcoin blockchain queries
 *
 * Uses standard fetch API (works in browser, Node.js 18+, React Native)
 * Supports mempool.space API for testnet/mainnet
 */

export interface EsploraTransaction {
  txid: string;
  version: number;
  locktime: number;
  vin: EsploraVin[];
  vout: EsploraVout[];
  size: number;
  weight: number;
  fee: number;
  status: EsploraStatus;
}

export interface EsploraVin {
  txid: string;
  vout: number;
  prevout: EsploraVout | null;
  scriptsig: string;
  scriptsig_asm: string;
  witness?: string[];
  is_coinbase: boolean;
  sequence: number;
}

export interface EsploraVout {
  scriptpubkey: string;
  scriptpubkey_asm: string;
  scriptpubkey_type: string;
  scriptpubkey_address?: string;
  value: number;
}

export interface EsploraStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface EsploraAddressInfo {
  address: string;
  chain_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
  mempool_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
}

export interface EsploraUtxo {
  txid: string;
  vout: number;
  status: EsploraStatus;
  value: number;
}

export interface EsploraMerkleProof {
  block_height: number;
  merkle: string[];
  pos: number;
}

export type EsploraNetwork = "mainnet" | "testnet" | "testnet4" | "signet";

const NETWORK_URLS: Record<EsploraNetwork, string> = {
  mainnet: "https://mempool.space/api",
  testnet: "https://mempool.space/testnet/api",
  testnet4: "https://mempool.space/testnet4/api",
  signet: "https://mempool.space/signet/api",
};

export class EsploraClient {
  private baseUrl: string;
  private network: EsploraNetwork;

  constructor(
    networkOrUrl: EsploraNetwork | string = "testnet",
    customBaseUrl?: string
  ) {
    if (customBaseUrl) {
      this.baseUrl = customBaseUrl.replace(/\/$/, "");
      this.network = networkOrUrl as EsploraNetwork;
    } else if (networkOrUrl in NETWORK_URLS) {
      this.network = networkOrUrl as EsploraNetwork;
      this.baseUrl = NETWORK_URLS[this.network];
    } else {
      // Assume it's a custom URL
      this.baseUrl = networkOrUrl.replace(/\/$/, "");
      this.network = "testnet";
    }
  }

  private async fetch<T>(endpoint: string): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Esplora API error: ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return res.json() as Promise<T>;
    }

    // For text responses (like block height)
    const text = await res.text();
    return text as T;
  }

  // =========================================================================
  // Address endpoints
  // =========================================================================

  async getAddress(address: string): Promise<EsploraAddressInfo> {
    return this.fetch<EsploraAddressInfo>(`/address/${address}`);
  }

  async getAddressTxs(
    address: string,
    lastSeenTxid?: string
  ): Promise<EsploraTransaction[]> {
    const endpoint = lastSeenTxid
      ? `/address/${address}/txs/chain/${lastSeenTxid}`
      : `/address/${address}/txs`;
    return this.fetch<EsploraTransaction[]>(endpoint);
  }

  async getAddressTxsMempool(address: string): Promise<EsploraTransaction[]> {
    return this.fetch<EsploraTransaction[]>(`/address/${address}/txs/mempool`);
  }

  async getAddressUtxos(address: string): Promise<EsploraUtxo[]> {
    return this.fetch<EsploraUtxo[]>(`/address/${address}/utxo`);
  }

  // =========================================================================
  // Transaction endpoints
  // =========================================================================

  async getTransaction(txid: string): Promise<EsploraTransaction> {
    return this.fetch<EsploraTransaction>(`/tx/${txid}`);
  }

  async getTxStatus(txid: string): Promise<EsploraStatus> {
    return this.fetch<EsploraStatus>(`/tx/${txid}/status`);
  }

  async getTxHex(txid: string): Promise<string> {
    return this.fetch<string>(`/tx/${txid}/hex`);
  }

  async getTxRaw(txid: string): Promise<Uint8Array> {
    const hex = await this.getTxHex(txid);
    return hexToBytes(hex);
  }

  async getTxMerkleProof(txid: string): Promise<EsploraMerkleProof> {
    return this.fetch<EsploraMerkleProof>(`/tx/${txid}/merkle-proof`);
  }

  async getTxOutspend(
    txid: string,
    vout: number
  ): Promise<{
    spent: boolean;
    txid?: string;
    vin?: number;
    status?: EsploraStatus;
  }> {
    return this.fetch(`/tx/${txid}/outspend/${vout}`);
  }

  // =========================================================================
  // Block endpoints
  // =========================================================================

  async getBlockHeight(): Promise<number> {
    const height = await this.fetch<string>("/blocks/tip/height");
    return parseInt(height, 10);
  }

  async getBlockHash(height: number): Promise<string> {
    return this.fetch<string>(`/block-height/${height}`);
  }

  async getBlockHeader(hash: string): Promise<string> {
    return this.fetch<string>(`/block/${hash}/header`);
  }

  async getBlockTxids(hash: string): Promise<string[]> {
    return this.fetch<string[]>(`/block/${hash}/txids`);
  }

  // =========================================================================
  // Helper methods
  // =========================================================================

  async getConfirmations(txid: string): Promise<number> {
    const status = await this.getTxStatus(txid);
    if (!status.confirmed || status.block_height === undefined) {
      return 0;
    }
    const tipHeight = await this.getBlockHeight();
    return tipHeight - status.block_height + 1;
  }

  async waitForTransaction(
    address: string,
    timeoutMs: number = 600000,
    pollIntervalMs: number = 5000
  ): Promise<EsploraTransaction | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // Check mempool first
      const mempoolTxs = await this.getAddressTxsMempool(address);
      if (mempoolTxs.length > 0) {
        return mempoolTxs[0];
      }

      // Check confirmed
      const confirmedTxs = await this.getAddressTxs(address);
      if (confirmedTxs.length > 0) {
        return confirmedTxs[0];
      }

      await sleep(pollIntervalMs);
    }

    return null;
  }

  async waitForConfirmations(
    txid: string,
    requiredConfirmations: number = 6,
    timeoutMs: number = 3600000,
    pollIntervalMs: number = 30000
  ): Promise<number> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const confirmations = await this.getConfirmations(txid);
      if (confirmations >= requiredConfirmations) {
        return confirmations;
      }
      await sleep(pollIntervalMs);
    }

    return await this.getConfirmations(txid);
  }

  /**
   * Find a deposit to a specific address matching the expected amount
   */
  async findDeposit(
    address: string,
    expectedAmount?: bigint
  ): Promise<{ tx: EsploraTransaction; vout: number; amount: number } | null> {
    // Check mempool first
    const mempoolTxs = await this.getAddressTxsMempool(address);
    for (const tx of mempoolTxs) {
      const result = this.findMatchingOutput(tx, address, expectedAmount);
      if (result) return result;
    }

    // Check confirmed transactions
    const confirmedTxs = await this.getAddressTxs(address);
    for (const tx of confirmedTxs) {
      const result = this.findMatchingOutput(tx, address, expectedAmount);
      if (result) return result;
    }

    return null;
  }

  private findMatchingOutput(
    tx: EsploraTransaction,
    address: string,
    expectedAmount?: bigint
  ): { tx: EsploraTransaction; vout: number; amount: number } | null {
    for (let i = 0; i < tx.vout.length; i++) {
      const output = tx.vout[i];
      if (output.scriptpubkey_address === address) {
        if (
          expectedAmount === undefined ||
          BigInt(output.value) === expectedAmount
        ) {
          return { tx, vout: i, amount: output.value };
        }
      }
    }
    return null;
  }

  getNetwork(): EsploraNetwork {
    return this.network;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }
}

// =========================================================================
// Utility functions
// =========================================================================

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Default client for testnet
export const esploraTestnet = new EsploraClient("testnet");
export const esploraMainnet = new EsploraClient("mainnet");
