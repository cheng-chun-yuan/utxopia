export type UTXOpiaChain = "solana" | "sui";

export type TransactionEnvelopeKind =
  | "solana-transaction"
  | "sui-programmable-transaction-block";

export interface PoolState {
  chain: UTXOpiaChain;
  poolId: string;
  paused: boolean;
  latestMerkleRoot: string;
  treeDepth: number;
}

export interface MerkleRoot {
  root: string;
  index: number;
  observedAt: string;
}

export interface Note {
  commitment: string;
  nullifier?: string;
  tokenId: string;
  amount?: bigint;
  leafIndex: number;
  encryptedPayload?: string;
}

export interface NoteScanInput {
  viewingKey: string;
  fromCursor?: string;
  tokenIds?: string[];
}

export interface ShieldInput {
  recipient: string;
  tokenId: string;
  amount: bigint;
  metadata?: Record<string, string>;
}

export interface TransactInput {
  inputNotes: Note[];
  outputs: Array<{
    recipient: string;
    tokenId: string;
    amount: bigint;
  }>;
  proof: Uint8Array;
  boundParamsHash: string;
  vkHash?: Uint8Array;
  publicInputs?: Uint8Array;
  proofPoints?: Uint8Array;
  nullifiers?: Uint8Array[];
  commitmentsOut?: Uint8Array[];
}

export interface RedemptionInput {
  inputNotes: Note[];
  btcAddress: string;
  amountSats: bigint;
  maxFeeSats: bigint;
  proof: Uint8Array;
}

export interface RegisterVerifyingKeyInput {
  nInputs: number;
  nOutputs: number;
  nPublic: number;
  vkHash: Uint8Array;
  rawVerifyingKey?: Uint8Array;
  vkGammaAbcG1Bytes: Uint8Array;
  alphaG1BetaG2Bytes: Uint8Array;
  gammaG2NegPcBytes: Uint8Array;
  deltaG2NegPcBytes: Uint8Array;
}

export interface BaseUnsignedTransaction {
  chain: UTXOpiaChain;
  kind: TransactionEnvelopeKind;
  bytes: Uint8Array;
  description: string;
}

export interface SolanaUnsignedTransaction extends BaseUnsignedTransaction {
  chain: "solana";
  kind: "solana-transaction";
}

export interface SuiUnsignedTransaction extends BaseUnsignedTransaction {
  chain: "sui";
  kind: "sui-programmable-transaction-block";
  packageId: string;
  objectIds: string[];
}

export type UnsignedTransaction =
  | SolanaUnsignedTransaction
  | SuiUnsignedTransaction;

export interface BaseSignedTransaction {
  chain: UTXOpiaChain;
  kind: TransactionEnvelopeKind;
  bytes: Uint8Array;
}

export type SignedTransaction = BaseSignedTransaction;

export interface TransactionResult {
  chain: UTXOpiaChain;
  digest: string;
  confirmed: boolean;
  checkpoint?: string;
  eventCursor?: string;
}

export interface UTXOpiaChainAdapter {
  readonly chain: UTXOpiaChain;

  getPoolState(): Promise<PoolState>;
  getLatestMerkleRoot(): Promise<MerkleRoot>;
  getNotes(input: NoteScanInput): Promise<Note[]>;

  buildShieldTransaction(input: ShieldInput): Promise<UnsignedTransaction>;
  buildTransactTransaction(input: TransactInput): Promise<UnsignedTransaction>;
  buildRedemptionTransaction(input: RedemptionInput): Promise<UnsignedTransaction>;
  buildRegisterVerifyingKeyTransaction?(input: RegisterVerifyingKeyInput): Promise<UnsignedTransaction>;

  submitTransaction(tx: SignedTransaction): Promise<TransactionResult>;
}
