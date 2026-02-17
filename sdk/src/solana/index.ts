/**
 * Solana Subpath
 *
 * Solana-related utilities for ZVault:
 * - PDA derivation
 * - Instruction builders
 * - Network configuration
 * - ChadBuffer for large proof uploads
 */

// PDA derivation
export {
  ZVAULT_PROGRAM_ID,
  BTC_LIGHT_CLIENT_PROGRAM_ID,
  PDA_SEEDS,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierRecordPDA,
  deriveStealthAnnouncementPDA,
  deriveDepositRecordPDA,
  deriveLightClientPDA,
  deriveBlockHeaderPDA,
  deriveNameRegistryPDA,
  commitmentToBytes,
} from "../pda";

// Instruction builders
export {
  INSTRUCTION_DISCRIMINATORS,
  buildClaimInstructionData,
  buildClaimInstruction,
  buildSplitInstructionData,
  buildSplitInstruction,
  buildSpendPartialPublicInstructionData,
  buildSpendPartialPublicInstruction,
  buildRedemptionRequestInstructionData,
  buildRedemptionRequestInstruction,
  bigintTo32Bytes,
  bytes32ToBigint,
  type Instruction,
  type ClaimInstructionOptions,
  type SplitInstructionOptions,
  type SpendPartialPublicInstructionOptions,
  type RedemptionRequestInstructionOptions,
} from "../instructions";

// Network configuration
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
  type NetworkConfig,
  type NetworkType,
} from "../config";

// ChadBuffer utilities (for large proof uploads)
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
} from "../chadbuffer";

// Commitment tree parsing and on-chain fetch
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
} from "../commitment-tree";

// Relay utilities
export {
  relaySpendPartialPublic,
  relaySpendSplit,
  createChadBuffer as relayCreateChadBuffer,
  uploadProofToBuffer as relayUploadProofToBuffer,
  closeChadBuffer as relayCloseChadBuffer,
  type RelaySpendPartialPublicParams,
  type RelaySpendSplitParams,
  type RelayResult,
} from "../relay";

// Priority fee estimation
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
} from "./priority-fee";

// Connection adapter factory
export {
  createFetchConnectionAdapter,
  createConnectionAdapterFromWeb3,
  createConnectionAdapterFromKit,
  getConnectionAdapter,
  clearConnectionAdapterCache,
  type RpcConfig,
  type Web3Connection,
  type KitRpc,
} from "./connection";
