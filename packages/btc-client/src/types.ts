export type BitcoinNetwork = "mainnet" | "testnet" | "testnet4" | "signet" | "regtest";

export interface BitcoinTxStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface BitcoinTxInput {
  txid: string;
  vout: number;
  prevout: BitcoinTxOutput | null;
  scriptsig: string;
  scriptsig_asm: string;
  witness?: string[];
  is_coinbase: boolean;
  sequence: number;
}

export interface BitcoinTxOutput {
  scriptpubkey: string;
  scriptpubkey_asm: string;
  scriptpubkey_type: string;
  scriptpubkey_address?: string;
  value: number;
}

export interface BitcoinTransaction {
  txid: string;
  version: number;
  locktime: number;
  vin: BitcoinTxInput[];
  vout: BitcoinTxOutput[];
  size: number;
  weight: number;
  fee: number;
  status: BitcoinTxStatus;
}

export interface BitcoinAddressInfo {
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

export interface BitcoinUtxo {
  txid: string;
  vout: number;
  status: BitcoinTxStatus;
  value: number;
}

export interface BitcoinMerkleProof {
  block_height: number;
  merkle: string[];
  pos: number;
}

export interface BitcoinOutspend {
  spent: boolean;
  txid?: string;
  vin?: number;
  status?: BitcoinTxStatus;
}

export interface BitcoinDepositCandidate {
  address: string;
  txid: string;
  vout: number;
  value: number;
  confirmations: number;
  status: BitcoinTxStatus;
  opReturn?: UtxopiaDepositOpReturn;
}

export interface UtxopiaDepositOpReturn {
  ephemeralPubkey: Uint8Array;
  npk: Uint8Array;
  rawPayload: Uint8Array;
}

export interface BitcoinClient {
  getAddress(address: string): Promise<BitcoinAddressInfo>;
  getAddressTxs(address: string, lastSeenTxid?: string): Promise<BitcoinTransaction[]>;
  getAddressUtxos(address: string): Promise<BitcoinUtxo[]>;
  getTransaction(txid: string): Promise<BitcoinTransaction>;
  getTxStatus(txid: string): Promise<BitcoinTxStatus>;
  getTxHex(txid: string): Promise<string>;
  getTxMerkleProof(txid: string): Promise<BitcoinMerkleProof>;
  getTxOutspend(txid: string, vout: number): Promise<BitcoinOutspend>;
  getBlockHeight(): Promise<number>;
  getBlockHash(height: number): Promise<string>;
  getBlockHeader(hash: string): Promise<string>;
  broadcastTx(txHex: string): Promise<string>;
}
