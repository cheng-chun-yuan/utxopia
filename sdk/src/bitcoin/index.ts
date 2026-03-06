/**
 * Bitcoin Subpath
 *
 * Bitcoin-related utilities for AEGIS:
 * - Taproot address derivation
 * - Claim link encoding/decoding
 * - Esplora API client
 */

// Taproot address utilities
export {
  deriveTaprootAddress,
  verifyTaprootAddress,
  createP2TRScriptPubkey,
  parseP2TRScriptPubkey,
  isValidBitcoinAddress,
  getInternalKey,
  createCustomInternalKey,
} from "../taproot";

// Claim link utilities
export {
  encodeClaimLink,
  decodeClaimLink,
  parseClaimUrl,
} from "../claim-link";

// Esplora API client
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
} from "../core/esplora";
