/**
 * Solana Subpath (JoinSplit Architecture)
 *
 * Solana-related utilities for AEGIS:
 * - PDA derivation
 * - Instruction builders
 * - Network configuration
 * - ChadBuffer for large proof uploads
 */

// PDA derivation
export {
  AEGIS_PROGRAM_ID,
  BTC_LIGHT_CLIENT_PROGRAM_ID,
  PDA_SEEDS,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierRecordPDA,
  deriveLightClientPDA,
  deriveBlockHeaderPDA,
  deriveHeightIndexPDA,
  deriveVkRegistryPDA,
  commitmentToBytes,
} from "../pda";

// Instruction builders (JoinSplit only)
export {
  INSTRUCTION_DISCRIMINATORS,
  buildRedemptionRequestInstructionData,
  buildRedemptionRequestInstruction,
  buildTransactInstructionData,
  buildTransactInstruction,
  bigintTo32Bytes,
  bytes32ToBigint,
  type Instruction,
  type RedemptionRequestInstructionOptions,
  type TransactInstructionOptions,
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
  JOINSPLIT_TREE_DEPTH,
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
  buildCommitmentTreeFromChain,
  getLeafIndexForCommitment,
  fetchMerkleProofForCommitment,
  getMerkleProofFromTree,
  type CommitmentTreeState,
  type RpcClient,
  type OnChainMerkleProof,
} from "../commitment-tree";

// ChadBuffer relay utilities
export {
  createChadBuffer as relayCreateChadBuffer,
  uploadProofToBuffer as relayUploadProofToBuffer,
  closeChadBuffer as relayCloseChadBuffer,
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

// Explorer (on-chain account fetchers & parsers)
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
} from "../explorer";

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
