/**
 * UTXOpia SDK v3.0 (JoinSplit Architecture)
 *
 * Complete client library for interacting with the UTXOpia protocol.
 * Private Bitcoin on Solana using ZK proofs.
 *
 * Networks: Solana Devnet + Bitcoin Testnet3
 *
 * ## Quick Start
 * ```typescript
 * import { depositToNote, generateJoinSplitProof, buildTransactInstruction } from '@utxopia/sdk';
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
  // Byte conversion (encoding utilities)
  bigintToBytes,
  bytesToBigint,
  hexToBytes,
  bytesToHex,
  // Hashing
  sha256Hash,
  // Low-level crypto (needed by E2E test scripts + contract deploy scripts)
  randomFieldElement,
  BN254_FIELD_PRIME,
} from "./crypto";

// ==========================================================================
// Key derivation (Solana wallet -> spending/viewing keys)
// ==========================================================================

export {
  // Key derivation (high-level)
  deriveKeysFromWallet,
  deriveKeysFromSeed,
  deriveKeysFromSeedCircuit,
  deriveKeysFromAuthSignature,
  setupKeysFromAuthSignature,
  generateRandomAuthSignature,
  // Key setup (combined derivation + stealth address)
  setupKeysFromWallet,
  setupKeysFromSeed,
  recreateStealthAddress,
  // EdDSA signing
  eddsaPoseidonSign,
  eddsaPoseidonSignWithScalar,
  eddsaGetPrivScalar,
  eddsaGetPubKey,
  // Stealth meta address
  createStealthMetaAddress,
  serializeStealthMetaAddress,
  deserializeStealthMetaAddress,
  encodeStealthMetaAddress,
  decodeStealthMetaAddress,
  // Key lifecycle
  clearUTXOpiaKeys,
  // Key serialization
  serializeKeysForStorage,
  deserializeKeysFromStorage,
  // Types
  type UTXOpiaKeys,
  type KeySetupResult,
  type AuthSignatureKeyDerivationOptions,
  type AuthSignatureKeySetupResult,
  type SerializedKeysForStorage,
  type StealthMetaAddress,
  type WalletSignerAdapter,
} from "./keys";

// Delegated viewing keys + auditor toolkit (Phase 1)
export {
  ViewPermissions,
  hasPermission,
  isDelegatedKeyValid,
  isSlotInDelegatedRange,
  createDelegatedViewKey,
  serializeDelegatedViewKey,
  deserializeDelegatedViewKey,
  makeDelegationRecord,
  fingerprintDelegatedKey,
  clearDelegatedViewKey,
  type DelegatedViewKey,
  type DelegationRecord,
} from "./keys";
export {
  auditScan,
  auditRecordsToCsv,
  type AuditDirection,
  type AuditRecord,
  type AuditScanAnnouncement,
  type AuditScanOptions,
  type AuditScanSummary,
  type OnChainSenderMemo,
} from "./auditor";

// Sender memo channel (Phase 2)
export {
  encryptSenderMemo,
  decryptSenderMemo,
  deriveOutgoingViewingKey,
  packSenderMemo,
  unpackSenderMemo,
  packSenderMemoForInstruction,
  buildSenderMemosForTransact,
  generateSenderMemoNonce,
  SENDER_MEMO_AMOUNT_BYTES,
  SENDER_MEMO_CIPHERTEXT_BYTES,
  SENDER_MEMO_COMMITMENT_BYTES,
  SENDER_MEMO_NONCE_BYTES,
  SENDER_MEMO_PACKED_BYTES,
  SENDER_MEMO_TAG_BYTES,
  SENDER_MEMO_TOKEN_BYTES,
  type SenderMemoPlain,
  type SenderMemoCiphertext,
  type SenderMemoOutput,
} from "./sender-memo";

// Selective ZK disclosure proofs (Phase 4)
export {
  generateOwnershipProof,
  generateRangeSumProof,
  computeRangeSumAttestation,
  pickRangeSumVariant,
  RANGE_SUM_N,
  RANGE_SUM_VARIANTS,
  RANGE_SUM_SIZES,
  type OwnershipProofInputs,
  type OwnershipPublicInputs,
  type RangeSumAttestationStyle,
  type RangeSumProofInputs,
  type RangeSumPublicInputs,
} from "./selective-disclosure";

// ==========================================================================
// Poseidon hash utilities
// ==========================================================================

export {
  initPoseidon,
  poseidonHashSync,
  // JoinSplit primitives (used by E2E scripts + pay-flow)
  computeMPKSync,
  computeNPKSync,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
  // Multi-token
  computeTokenId,
  reduceToField,
} from "./poseidon";

// ==========================================================================
// Token Registry (multi-token support)
// ==========================================================================

export {
  getTokenConfig,
  getTokenId,
  fetchSupportedTokens,
  fetchEnabledTokens,
  parseTokenConfig,
  type TokenConfigData,
  type SupportedToken,
} from "./token-registry";

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
  parseMerkleProofResponse,
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
  deriveTaprootAddressWithRefund,
  buildRefundScript,
  computeTapLeafHash,
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
  encodeClaimLink,
  decodeClaimLink,
  parseClaimUrl,
} from "./claim-link";

// ==========================================================================
// WASM Prover (Browser + Node.js) — JoinSplit only
// ==========================================================================

// Prover types only (no runtime dependency on snarkjs)
// For prover runtime functions (initProver, generateJoinSplitProof, etc.), import from:
// - @utxopia/sdk/prover/web    (browser/Node.js — uses snarkjs)
// - @utxopia/sdk/prover/mobile (React Native — uses mopro-ffi)
export type {
  ProofData,
  MerkleProofInput,
  CircuitType,
  JoinSplitProofInputs,
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
  computeStealthDataHash,
  createTransferBoundParams,
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
  initConfig,
  DEVNET_CONFIG,
  MAINNET_CONFIG,
  LOCALNET_CONFIG,
  TOKEN_PROGRAM_ID,
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
  UTXOPIA_PROGRAM_ID,
  BTC_LIGHT_CLIENT_PROGRAM_ID,
  PDA_SEEDS,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierRecordPDA,
  deriveLightClientPDA,
  deriveBlockHeaderPDA,
  deriveHeightIndexPDA,
  deriveVkRegistryPDA,
  deriveRedemptionRequestPDA,
  deriveTokenConfigPDA,
  deriveDepositReceiptPDA,
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
  scanAnnouncements,
  scanAnnouncementsViewOnly,
  exportViewOnlyKeys,
  encodeViewOnlyKeys,
  decodeViewOnlyKeys,
  prepareClaimInputs,
  scanUnifiedNotes,
  encryptAmount,
  decryptAmount,
  computeNullifierHashForNote,
  computeNullifierBytes,
  parseAnnouncementsFromHex,
  createDepositFromConfig,
  createDirectVaultDeposit,
  isDepositForViewer,
  isDepositForViewerHex,
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
  isDirectVaultDepositMode,
  pickIkaCustodyKey,
  type NonInteractiveDepositResult,
  type NonInteractiveDepositWithRefundResult,
} from "./stealth";

// ==========================================================================
// Direct stealth deposit (combined BTC deposit + stealth announcement)
// ==========================================================================

export {
  prepareStealthDeposit,
  buildStealthOpReturn,
  parseStealthOpReturn,
  completeDeposit,
  STEALTH_OP_RETURN_SIZE,
  COMPLETE_DEPOSIT_DISCRIMINATOR,
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
// Debug Logging
// ==========================================================================

export { setDebug } from "./logger";

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
// SNS Subdomain Resolver (*.utxopia.sol stealth addresses)
// ==========================================================================

export {
  resolveSnsName,
  resolveStealthName,
  parseSnsStealthData,
  isSnsStealthAddress,
  isAuditorDisclosable,
  SnsComplianceFlags,
  SNS_COMPLIANCE_AUDITOR_OFFSET,
  SNS_COMPLIANCE_AUDITOR_BYTES,
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
  // Shield instruction
  buildShieldInstructionData,
  buildShieldInstruction,
  type ShieldInstructionOptions,
  buildRedemptionRequestInstructionData,
  buildRedemptionRequestInstruction,
  buildApproveRedemptionSigningInstructionData,
  buildApproveRedemptionSigningInstruction,
  bigintTo32Bytes,
  bytes32ToBigint,
  // JoinSplit transact instruction
  buildTransactInstructionData,
  buildTransactInstruction,
  // JoinSplit + BTC redeem instruction
  buildRedeemInstructionData,
  // Public unshield instruction
  buildUnshieldInstructionData,
  buildUnshieldInstruction,
  // Timelocked pool update instructions
  buildProposePoolUpdateInstructionData,
  buildProposePoolUpdateInstruction,
  buildExecutePoolUpdateInstructionData,
  buildExecutePoolUpdateInstruction,
  buildCancelPoolUpdateInstructionData,
  buildCancelPoolUpdateInstruction,
  // Rotate tree
  buildRotateTreeInstructionData,
  buildRotateTreeInstruction,
  type RotateTreeOptions,
  // Verify instruction data builders
  buildVerifyTransactionInstructionData,
  buildVerifyStealthDepositInstructionData,
  // Redemption PDA helper
  deriveRedemptionRequestPDA as deriveRedemptionRequestPDAFromInstruction,
  type Instruction,
  type RedemptionRequestInstructionOptions,
  type ApproveRedemptionSigningInstructionOptions,
  type TransactInstructionOptions,
  type UnshieldInstructionOptions,
  type ProposePoolUpdateOptions,
  type ExecutePoolUpdateOptions,
  type CancelPoolUpdateOptions,
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
  parseNullifierSpentEvent,
  parseStealthAnnouncementEvent,
  parseSenderMemoEvent,
  parseBtcOriginAttestationEvent,
  EVENT_NULLIFIER_SPENT,
  EVENT_STEALTH_ANNOUNCEMENT,
  EVENT_NULLIFIERS_BATCH,
  EVENT_ANNOUNCEMENTS_BATCH,
  EVENT_SENDER_MEMO,
  EVENT_BTC_ORIGIN_ATTESTATION,
  type NullifierSpentEvent,
  type StealthAnnouncementEvent,
  type SenderMemoEvent,
  type BtcOriginAttestationEvent,
  type ProgramEvent,
} from "./events";

// ==========================================================================
// Announcement Client (WS + REST + RPC fallback)
// ==========================================================================

export {
  AnnouncementClient,
  type AnnouncementClientConfig,
  type AnnouncementListener,
} from "./announcement-client";

// ==========================================================================
// Event Client (unified WS + REST for all event types)
// ==========================================================================

export {
  EventClient,
  type LeafInsertedEvent as EventLeafInserted,
  type NullifierSpentEvent as EventNullifierSpent,
  type AnnouncementEvent as EventAnnouncement,
  type ServerEvent as EventServerEvent,
  type EventListener,
  type TreeStatusResponse,
  type NullifierPdasResponse,
} from "./event-client";

// ==========================================================================
// High-Level Client (Phase 1: init + auth + balance)
// ==========================================================================

export {
  UTXOpiaClient,
  type UTXOpiaClientConfig,
  type TokenDefinition,
  type InboxNote as ClientInboxNote,
} from "./client";
