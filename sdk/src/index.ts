/**
 * Aegis SDK v3.0 (JoinSplit Architecture)
 *
 * Complete client library for interacting with the Aegis protocol.
 * Private Bitcoin on Solana using ZK proofs.
 *
 * Networks: Solana Devnet + Bitcoin Testnet3
 *
 * ## Quick Start
 * ```typescript
 * import { depositToNote, generateJoinSplitProof, buildTransactInstruction } from '@aegis/sdk';
 *
 * // 1. DEPOSIT: Generate credentials
 * const result = await depositToNote(100_000n); // 0.001 BTC
 * console.log('Send BTC to:', result.taprootAddress);
 *
 * // 2. TRANSACT: JoinSplit proof for private transfer
 * const proof = await generateJoinSplitProof(inputs);
 *
 * // 3. BUILD: Create Solana instruction
 * const ix = buildTransactInstruction(options);
 * ```
 */

// ==========================================================================
// Cryptographic utilities
// ==========================================================================

export {
  // Field constants
  BN254_FIELD_PRIME,
  // Baby Jubjub constants
  BABYJUB_FIELD_PRIME,
  BABYJUB_A,
  BABYJUB_D,
  BABYJUB_ORDER,
  BABYJUB_BASE8,
  BABYJUB_IDENTITY,
  // Byte conversion
  randomFieldElement,
  bigintToBytes,
  bytesToBigint,
  hexToBytes,
  bytesToHex,
  // Hashing
  sha256Hash,
  doubleSha256,
  taggedHash,
  // Baby Jubjub curve operations (spending keys)
  babyJubAdd,
  babyJubDouble,
  babyJubMul,
  babyJubNegate,
  isOnBabyJubCurve,
  isIdentity,
  babyJubCompress,
  babyJubDecompress,
  generateBabyJubKeyPair,
  deriveBabyJubKeyFromSeed,
  babyJubScalarFromBytes,
  babyJubScalarToBytes,
  // Scalar utilities
  scalarFromBytes,
  scalarToBytes,
  // Ed25519/X25519 (viewing keys)
  ed25519GenerateKeyPair,
  ed25519GetPublicKey,
  ed25519DeriveKeyFromSeed,
  ed25519PubToX25519,
  x25519Ecdh,
  deriveAmountKey,
  encryptAmountEd25519,
  decryptAmountEd25519,
  // Types
  type BabyJubPoint,
} from "./crypto";

// ==========================================================================
// Key derivation (Solana wallet -> spending/viewing keys)
// ==========================================================================

export {
  deriveKeysFromWallet,
  deriveKeysFromSignature,
  deriveKeysFromSeed,
  deriveKeysFromSeedCircuit,
  eddsaPoseidonSignWithScalar,
  eddsaGetPubKey,
  eddsaGetPrivScalar,
  eddsaPoseidonSign,
  SPENDING_KEY_DERIVATION_MESSAGE,
  createStealthMetaAddress,
  serializeStealthMetaAddress,
  deserializeStealthMetaAddress,
  parseStealthMetaAddress,
  encodeStealthMetaAddress,
  decodeStealthMetaAddress,
  createDelegatedViewKey,
  serializeDelegatedViewKey,
  deserializeDelegatedViewKey,
  isDelegatedKeyValid,
  hasPermission,
  ViewPermissions,
  constantTimeCompare,
  clearKey,
  clearAegisKeys,
  clearDelegatedViewKey,
  extractViewOnlyBundle,
  type AegisKeys,
  type StealthMetaAddress,
  type SerializedStealthMetaAddress,
  type DelegatedViewKey,
  type WalletSignerAdapter,
} from "./keys";

// ==========================================================================
// Poseidon hash utilities
// ==========================================================================

export {
  poseidonHash,
  poseidonHashSync,
  initPoseidon,
  computeUnifiedCommitment,
  computeNullifier,
  hashNullifier,
  computeUnifiedCommitmentSync,
  computeNullifierSync,
  hashNullifierSync,
  BN254_SCALAR_FIELD,
  // JoinSplit primitives
  computeMPK,
  computeMPKSync,
  computeNPK,
  computeNPKSync,
  computeJoinSplitCommitment,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifier,
  computeJoinSplitNullifierSync,
} from "./poseidon";

// ==========================================================================
// Note (shielded commitment) utilities
// ==========================================================================

export {
  generateNote,
  createNoteFromSecrets,
  updateNoteWithHashes,
  serializeNote,
  deserializeNote,
  noteHasComputedHashes,
  getNotePublicKeyX,
  computeNoteCommitment,
  computeNoteNullifier,
  formatBtc,
  parseBtc,
  deriveNote,
  deriveNotes,
  deriveMasterKey,
  deriveNoteFromMaster,
  estimateSeedStrength,
  createNote,
  isPoseidonReady,
  prepareWithdrawal,
  createStealthNote,
  updateStealthNoteWithHashes,
  serializeStealthNote,
  deserializeStealthNote,
  stealthNoteHasComputedHashes,
  type Note,
  type SerializedNote,
  type NoteData,
  type StealthNote,
  type SerializedStealthNote,
  // JoinSplit note types
  createJoinSplitNote,
  computeJoinSplitNoteNullifier,
  serializeJoinSplitNote,
  deserializeJoinSplitNote,
  type JoinSplitNote,
  type SerializedJoinSplitNote,
} from "./note";

// ==========================================================================
// Merkle tree utilities
// ==========================================================================

export {
  createMerkleProof,
  createMerkleProofFromBigints,
  proofToCircomFormat,
  proofToOnChainFormat,
  createEmptyMerkleProof,
  leafIndexToPathIndices,
  pathIndicesToLeafIndex,
  validateMerkleProofStructure,
  TREE_DEPTH,
  ROOT_HISTORY_SIZE,
  MAX_LEAVES,
  ZERO_VALUE,
  type MerkleProof,
} from "./merkle";

// ==========================================================================
// Taproot address utilities
// ==========================================================================

export {
  deriveTaprootAddress,
  verifyTaprootAddress,
  createP2TRScriptPubkey,
  parseP2TRScriptPubkey,
  isValidBitcoinAddress,
  getInternalKey,
  createCustomInternalKey,
  createOpReturnScript,
  createOpReturnScriptFromPayload,
  parseOpReturnCommitment,
  buildMockBtcTransaction,
  buildDepositOpReturn,
  parseDepositOpReturn,
  DEPOSIT_OP_RETURN_SIZE,
} from "./taproot";

// ==========================================================================
// Claim link utilities
// ==========================================================================

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
} from "./claim-link";

// ==========================================================================
// WASM Prover (Browser + Node.js) — JoinSplit only
// ==========================================================================

export {
  initProver,
  isProverAvailable,
  setCircuitPath,
  getCircuitPath,
  proofToBytes,
  cleanup as cleanupProver,
  getGroth16VerifierProgramId,
  buildVerifyInstructionData,
  type ProofData,
  type MerkleProofInput,
  type CircuitType,
  // JoinSplit prover
  generateJoinSplitProof,
  circuitExists,
  type JoinSplitProofInputs,
} from "./prover/web";

// ==========================================================================
// ChadBuffer utilities (for large proof uploads)
// ==========================================================================

export {
  uploadTransactionToBuffer,
  uploadProofToBuffer,
  closeBuffer,
  readBufferData,
  fetchRawTransaction,
  fetchMerkleProof,
  prepareVerifyDeposit,
  buildMerkleProof,
  needsBuffer as bufferNeedsBuffer,
  getProofSource,
  calculateUploadTransactions,
  CHADBUFFER_PROGRAM_ID,
  AUTHORITY_SIZE,
  MAX_DATA_PER_WRITE,
  SOLANA_TX_SIZE_LIMIT,
  type ProofUploadResult,
} from "./chadbuffer";

// ==========================================================================
// Bound Parameters (JoinSplit transaction binding)
// ==========================================================================

export {
  computeBoundParamsHash,
  createUnshieldBoundParams,
  createRedeemBoundParams,
  DEFAULT_BOUND_PARAMS,
  type BoundParams,
  type BoundParamsMode,
} from "./bound-params";

// ==========================================================================
// Configuration
// ==========================================================================

export {
  getConfig,
  setConfig,
  createConfig,
  DEVNET_CONFIG,
  MAINNET_CONFIG,
  LOCALNET_CONFIG,
  TOKEN_2022_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SDK_VERSION,
  DEPLOYMENT_INFO,
  JOINSPLIT_TREE_DEPTH,
  type NetworkConfig,
  type NetworkType,
} from "./config";

// ==========================================================================
// PDA Derivation
// ==========================================================================

export {
  AEGIS_PROGRAM_ID,
  BTC_LIGHT_CLIENT_PROGRAM_ID,
  PDA_SEEDS,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierRecordPDA,
  deriveStealthAnnouncementPDA,
  deriveDepositStealthPDA,
  deriveLightClientPDA,
  deriveBlockHeaderPDA,
  deriveHeightIndexPDA,
  deriveVkRegistryPDA,
  deriveRedemptionRequestPDA,
  commitmentToBytes,
} from "./pda";

// ==========================================================================
// Stealth address utilities
// ==========================================================================

export {
  isWalletAdapter,
  createStealthDeposit,
  createStealthDepositWithKeys,
  createStealthOutput,
  createStealthOutputWithKeys,
  createStealthOutputForCommitment,
  packStealthOutputForCircuit,
  deriveStealthAnnouncementPda,
  scanAnnouncements,
  scanAnnouncementsViewOnly,
  exportViewOnlyKeys,
  encodeViewOnlyKeys,
  decodeViewOnlyKeys,
  prepareClaimInputs,
  parseStealthAnnouncement,
  scanUnifiedNotes,
  encryptAmount,
  decryptAmount,
  computeNullifierHashForNote,
  isDepositForViewer,
  STEALTH_ANNOUNCEMENT_SIZE,
  STEALTH_ANNOUNCEMENT_DISCRIMINATOR,
  ANNOUNCEMENT_TYPE_DEPOSIT,
  ANNOUNCEMENT_TYPE_TRANSFER,
  type StealthDeposit,
  type StealthOutputData,
  type StealthOutputWithKeys,
  type CircuitStealthOutput,
  type ScannedNote,
  type ClaimInputs as StealthClaimInputs,
  type OnChainStealthAnnouncement,
  type ConnectionAdapter,
  type ViewOnlyKeys,
  type ViewOnlyScannedNote,
  createNonInteractiveDeposit,
  type NonInteractiveDepositResult,
} from "./stealth";

// ==========================================================================
// Direct stealth deposit (combined BTC deposit + stealth announcement)
// ==========================================================================

export {
  prepareStealthDeposit,
  buildStealthOpReturn,
  parseStealthOpReturn,
  verifyStealthDeposit,
  STEALTH_OP_RETURN_SIZE,
  VERIFY_STEALTH_DEPOSIT_DISCRIMINATOR,
  type PreparedStealthDeposit,
  type StealthDepositData,
  type ParsedStealthOpReturn,
  type Ed25519KeyPair,
} from "./stealth-deposit";

// ==========================================================================
// PSBT builder for wallet-integrated deposits
// ==========================================================================

export {
  buildDepositPsbt,
  estimateDepositFee,
  fetchUtxos,
  selectUtxos,
  type BuildDepositPsbtParams,
  type BuildDepositPsbtResult,
  type UtxoDescriptor,
} from "./psbt";

// ==========================================================================
// Simplified API
// ==========================================================================

export {
  depositToNote,
} from "./api";

export type {
  DepositResult,
  ApiClientConfig,
} from "./api";

// ==========================================================================
// Core utilities
// ==========================================================================

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
} from "./core/esplora";

// Mempool.space client with SPV support
export {
  MempoolClient,
  mempoolTestnet,
  mempoolMainnet,
  reverseBytes,
  type BlockHeader,
  type TransactionInfo,
  type SPVProofData,
} from "./core/mempool";

// ==========================================================================
// Priority Fee Estimation
// ==========================================================================

export {
  estimatePriorityFee,
  buildPriorityFeeInstructionData,
  encodeSetComputeUnitLimit,
  encodeSetComputeUnitPrice,
  getHeliusRpcUrl,
  DEFAULT_COMPUTE_UNITS,
  DEFAULT_PRIORITY_FEE,
  COMPUTE_BUDGET_DISCRIMINATORS,
  type PriorityFeeConfig,
  type PriorityFeeEstimate,
  type PriorityFeeInstructions,
} from "./solana/priority-fee";

// ==========================================================================
// Connection Adapter Factory
// ==========================================================================

export {
  createFetchConnectionAdapter,
  createConnectionAdapterFromWeb3,
  createConnectionAdapterFromKit,
  getConnectionAdapter,
  clearConnectionAdapterCache,
  type RpcConfig,
  type Web3Connection,
  type KitRpc,
} from "./solana/connection";

// ==========================================================================
// Deposit Watcher
// ==========================================================================

export {
  type DepositStatus,
  type PendingDeposit,
  type WatcherCallbacks,
  type WatcherConfig,
  type StorageAdapter,
  DEFAULT_WATCHER_CONFIG,
  serializeDeposit,
  deserializeDeposit,
  generateDepositId,
  BaseDepositWatcher,
  WebDepositWatcher,
  createWebWatcher,
  NativeDepositWatcher,
  createNativeWatcher,
  setAsyncStorage,
} from "./watcher";

// ==========================================================================
// React Hooks
// ==========================================================================

export {
  useDepositWatcher,
  useSingleDeposit,
  type UseDepositWatcherState,
  type UseDepositWatcherActions,
  type UseDepositWatcherReturn,
  type UseDepositWatcherOptions,
} from "./react";

// ==========================================================================
// SNS Subdomain Resolver (*.btcpro.sol stealth addresses)
// ==========================================================================

export {
  resolveSnsName,
  resolveStealthName,
  parseSnsStealthData,
  isSnsStealthAddress,
  deriveParentDomainKey,
  SNS_STEALTH_DATA_SIZE,
  SNS_STEALTH_DATA_SIZE_LEGACY_V1,
  SNS_STEALTH_DATA_SIZE_LEGACY_V2,
  type SnsStealthAddress,
} from "./sns-resolver";

// ==========================================================================
// Commitment Tree
// ==========================================================================

export {
  COMMITMENT_TREE_DISCRIMINATOR,
  parseCommitmentTreeData,
  isValidRoot,
  fetchCommitmentTree,
  getCommitmentIndex,
  saveCommitmentIndex,
  CommitmentTreeIndex,
  // On-chain fetch functions (Helius-compatible)
  buildCommitmentTreeFromChain,
  getLeafIndexForCommitment,
  fetchMerkleProofForCommitment,
  getMerkleProofFromTree,
  type CommitmentTreeState,
  type RpcClient,
  type OnChainMerkleProof,
} from "./commitment-tree";

// ==========================================================================
// Low-level Instruction Builders (JoinSplit only)
// ==========================================================================

export {
  INSTRUCTION_DISCRIMINATORS,
  buildRedemptionRequestInstructionData,
  buildRedemptionRequestInstruction,
  bigintTo32Bytes,
  bytes32ToBigint,
  // JoinSplit transact instruction
  buildTransactInstructionData,
  buildTransactInstruction,
  // Public unshield instruction
  buildUnshieldInstructionData,
  buildUnshieldInstruction,
  // Redeem: JoinSplit → BTC withdrawal
  buildRedeemInstructionData,
  buildRedeemInstruction,
  // Public redeem: burn SPL → BTC withdrawal
  buildPublicRedeemInstructionData,
  buildPublicRedeemInstruction,
  // Redemption PDA helper
  deriveRedemptionRequestPDA as deriveRedemptionRequestPDAFromInstruction,
  type Instruction,
  type RedemptionRequestInstructionOptions,
  type TransactInstructionOptions,
  type UnshieldInstructionOptions,
  type RedeemInstructionOptions,
  type PublicRedeemInstructionOptions,
} from "./instructions";

// ==========================================================================
// ChadBuffer Relay
// ==========================================================================

export {
  createChadBuffer as relayCreateChadBuffer,
  uploadProofToBuffer as relayUploadProofToBuffer,
  closeChadBuffer as relayCloseChadBuffer,
  type RelayResult,
} from "./relay";

// ==========================================================================
// Explorer (on-chain account fetchers & parsers)
// ==========================================================================

export {
  fetchExplorerDeposits,
  fetchExplorerTransfers,
  fetchExplorerRedemptions,
  parseNullifierRecord,
  parseRedemptionRequest,
  NULLIFIER_RECORD_SIZE,
  REDEMPTION_REQUEST_SIZE,
  NULLIFIER_RECORD_DISCRIMINATOR,
  REDEMPTION_REQUEST_DISCRIMINATOR,
  OPERATION_TYPE_LABELS,
  type ExplorerDeposit,
  type ExplorerTransferEvent,
  type ExplorerRedemption,
  type IndexerLeaf,
} from "./explorer";

// ==========================================================================
// Event Parsing (sol_log_data events from on-chain program)
// ==========================================================================

export {
  parseProgramEvents,
  parseLeafInsertedEvent,
  parseNullifierSpentEvent,
  EVENT_LEAF_INSERTED,
  EVENT_NULLIFIER_SPENT,
  type LeafInsertedEvent,
  type NullifierSpentEvent,
  type ProgramEvent,
} from "./events";

// ==========================================================================
// Demo Instructions (devnet/localnet only)
// ==========================================================================

export {
  DEMO_INSTRUCTION,
  buildAddDemoStealthData,
  parseAddDemoStealthData,
} from "./demo";
