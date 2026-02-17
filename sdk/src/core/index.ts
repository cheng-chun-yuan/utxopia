/**
 * Core Module - Platform-agnostic utilities
 *
 * Pure functions and clients that work everywhere:
 * - Browser
 * - Node.js
 * - React Native
 */

export {
  EsploraClient,
  esploraTestnet,
  esploraMainnet,
  type EsploraTransaction,
  type EsploraVin,
  type EsploraVout,
  type EsploraStatus,
  type EsploraAddressInfo,
  type EsploraUtxo,
  type EsploraMerkleProof,
  type EsploraNetwork,
} from "./esplora";

// Mempool.space client with SPV support
export {
  MempoolClient,
  mempoolTestnet,
  mempoolMainnet,
  reverseBytes,
  hexToBytes,
  bytesToHex,
  type BlockHeader,
  type TransactionInfo,
  type SPVProofData,
} from "./mempool";
