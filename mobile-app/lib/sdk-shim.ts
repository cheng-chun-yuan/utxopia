/**
 * SDK Shim for React Native
 *
 * Re-exports only the parts of @zvault/sdk that work in React Native.
 * Excludes Node.js-only modules (proof CLI, child_process, fs).
 *
 * For ZK proofs, use lib/proof.ts with snarkjs (Groth16 prover).
 */

// Crypto utilities
export {
  randomFieldElement,
  bigintToBytes,
  bytesToBigint,
  hexToBytes,
  bytesToHex,
  sha256Hash,
  doubleSha256,
  taggedHash,
  BN254_FIELD_PRIME,
} from '@zvault/sdk/crypto';

// Grumpkin curve operations
export {
  GRUMPKIN_FIELD_PRIME,
  GRUMPKIN_ORDER,
  GRUMPKIN_GENERATOR,
  pointAdd,
  pointDouble,
  pointMul,
  pointNegate,
  isOnCurve,
  scalarFromBytes,
  scalarToBytes,
  pointToBytes,
  pointFromBytes,
  pointToCompressedBytes,
  pointFromCompressedBytes,
  pubKeyToBytes,
  pubKeyFromBytes,
  generateKeyPair as generateGrumpkinKeyPair,
  deriveKeyPairFromSeed as deriveGrumpkinKeyPairFromSeed,
  ecdh as grumpkinEcdh,
  type GrumpkinPoint,
} from '@zvault/sdk/grumpkin';

// Key derivation
export {
  deriveKeysFromSignature,
  deriveKeysFromSeed,
  SPENDING_KEY_DERIVATION_MESSAGE,
  createStealthMetaAddress,
  serializeStealthMetaAddress,
  deserializeStealthMetaAddress,
  parseStealthMetaAddress,
  encodeStealthMetaAddress,
  decodeStealthMetaAddress,
  ViewPermissions,
  type ZVaultKeys,
  type StealthMetaAddress,
  type SerializedStealthMetaAddress,
  type DelegatedViewKey,
} from '@zvault/sdk/keys';

// Note utilities
export {
  generateNote,
  createNoteFromSecrets,
  serializeNote,
  deserializeNote,
  formatBtc,
  parseBtc,
  createNote,
  initPoseidon,
  isPoseidonReady,
  createStealthNote,
  serializeStealthNote,
  deserializeStealthNote,
  type Note,
  type SerializedNote,
  type StealthNote,
  type SerializedStealthNote,
} from '@zvault/sdk/note';

// Poseidon hashing
export {
  poseidon2Hash,
  computeCommitment,
  computeNullifier,
  hashNullifier,
  computeCommitmentLegacy,
  computeNullifierHashLegacy,
  BN254_SCALAR_FIELD,
} from '@zvault/sdk/poseidon2';

// Merkle tree utilities
export {
  createMerkleProof,
  createMerkleProofFromBigints,
  proofToNoirFormat,
  proofToOnChainFormat,
  createEmptyMerkleProof,
  TREE_DEPTH,
  ROOT_HISTORY_SIZE,
  type MerkleProof,
} from '@zvault/sdk/merkle';

// Taproot addresses
export {
  deriveTaprootAddress,
  verifyTaprootAddress,
  createP2TRScriptPubkey,
  isValidBitcoinAddress,
} from '@zvault/sdk/taproot';

// Claim links
export {
  createClaimLink,
  parseClaimLink,
  isValidClaimLinkFormat,
  shortenClaimLink,
  createProtectedClaimLink,
  extractAmountFromClaimLink,
  encodeClaimLink,
  decodeClaimLink,
  generateClaimUrl,
  parseClaimUrl,
  type ClaimLinkData,
} from '@zvault/sdk/claim-link';

// Stealth addresses
export {
  createStealthDeposit,
  scanAnnouncements,
  prepareClaimInputs,
  parseStealthAnnouncement,
  announcementToScanFormat,
  STEALTH_ANNOUNCEMENT_SIZE,
  STEALTH_ANNOUNCEMENT_DISCRIMINATOR,
  type StealthDeposit,
  type ScannedNote,
  type ClaimInputs,
  type OnChainStealthAnnouncement,
} from '@zvault/sdk/stealth';

// Watcher (React Native compatible)
export {
  type DepositStatus,
  type PendingDeposit,
  type WatcherCallbacks,
  type WatcherConfig,
  DEFAULT_WATCHER_CONFIG,
  serializeDeposit,
  deserializeDeposit,
  generateDepositId,
  NativeDepositWatcher,
  createNativeWatcher,
  setAsyncStorage,
} from '@zvault/sdk/watcher/index';

// React hooks
export {
  useDepositWatcher,
  useSingleDeposit,
  type UseDepositWatcherReturn,
  type UseDepositWatcherOptions,
} from '@zvault/sdk/react/index';

// Name registry
export {
  lookupZkeyName,
  isValidName,
  normalizeName,
  formatZkeyName,
  hashName,
  MAX_NAME_LENGTH,
  ZVAULT_PROGRAM_ID,
  type NameRegistryEntry,
  type ZkeyStealthAddress,
} from '@zvault/sdk/name-registry';
