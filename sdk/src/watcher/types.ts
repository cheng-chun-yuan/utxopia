/**
 * Deposit Watcher Types
 *
 * Platform-agnostic types for watching Bitcoin deposits and
 * tracking their confirmation status.
 */

import type { Note } from "../note";

/**
 * Status of a pending deposit
 */
export type DepositStatus =
  | "waiting" // Waiting for BTC transaction
  | "detected" // Transaction detected in mempool
  | "confirming" // Transaction confirmed, waiting for more confirmations
  | "confirmed" // Required confirmations reached
  | "verifying" // Verifying on Solana
  | "verified" // Verified on Solana, ready to claim
  | "claimed" // zBTC claimed
  | "failed"; // Something went wrong

/**
 * A pending deposit being watched
 */
export interface PendingDeposit {
  // Core identity
  id: string; // Unique identifier
  taprootAddress: string; // Bitcoin address to watch

  // Note secrets (for claiming later)
  nullifier: string; // Hex-encoded nullifier
  secret: string; // Hex-encoded secret
  amount: bigint; // Expected amount in satoshis

  // Claim link for sharing
  claimLink: string;

  // Status tracking
  status: DepositStatus;
  confirmations: number;
  requiredConfirmations: number;

  // Transaction details (populated after detection)
  txid?: string;
  vout?: number;
  detectedAmount?: number; // Actual amount received (satoshis)
  blockHeight?: number;
  blockHash?: string;

  // Solana verification (populated after verification)
  leafIndex?: number;
  commitment?: string; // Hex-encoded commitment

  // Timestamps
  createdAt: number;
  detectedAt?: number;
  confirmedAt?: number;
  verifiedAt?: number;
  claimedAt?: number;

  // Error tracking
  error?: string;
  lastErrorAt?: number;
}

/**
 * Callbacks for deposit watcher events
 */
export interface WatcherCallbacks {
  /**
   * Called when a transaction is first detected in mempool
   */
  onDetected?: (deposit: PendingDeposit) => void;

  /**
   * Called on each confirmation update
   */
  onConfirming?: (deposit: PendingDeposit, confirmations: number) => void;

  /**
   * Called when required confirmations are reached
   */
  onConfirmed?: (deposit: PendingDeposit) => void;

  /**
   * Called when deposit is verified on Solana
   */
  onVerified?: (deposit: PendingDeposit) => void;

  /**
   * Called when zBTC is claimed
   */
  onClaimed?: (deposit: PendingDeposit) => void;

  /**
   * Called on any error
   */
  onError?: (deposit: PendingDeposit, error: Error) => void;

  /**
   * Called on any status change
   */
  onStatusChange?: (
    deposit: PendingDeposit,
    oldStatus: DepositStatus,
    newStatus: DepositStatus
  ) => void;
}

/**
 * Storage adapter interface for platform-specific storage
 */
export interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Configuration for the deposit watcher
 */
export interface WatcherConfig {
  /**
   * Network for Esplora API
   */
  network?: "mainnet" | "testnet" | "testnet4" | "signet";

  /**
   * Custom Esplora API URL (overrides network)
   */
  esploraUrl?: string;

  /**
   * WebSocket URL for mempool.space
   */
  wsUrl?: string;

  /**
   * Number of confirmations required (default: 6)
   */
  requiredConfirmations?: number;

  /**
   * Polling interval for confirmation checks (ms, default: 30000)
   */
  confirmationPollInterval?: number;

  /**
   * Storage key prefix (default: 'zkbtc_')
   */
  storageKeyPrefix?: string;

  /**
   * Enable auto-verification on Solana when confirmed (default: true)
   */
  autoVerify?: boolean;

  /**
   * Enable WebSocket for real-time transaction detection (default: true)
   */
  useWebSocket?: boolean;

  /**
   * Polling interval when WebSocket is disabled (ms, default: 10000)
   */
  pollingInterval?: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_WATCHER_CONFIG: Required<WatcherConfig> = {
  network: "testnet",
  esploraUrl: "https://mempool.space/testnet/api",
  wsUrl: "wss://mempool.space/testnet/api/v1/ws",
  requiredConfirmations: 6,
  confirmationPollInterval: 30000,
  storageKeyPrefix: "zkbtc_",
  autoVerify: true,
  useWebSocket: true,
  pollingInterval: 10000,
};

/**
 * WebSocket message types from mempool.space
 */
export interface MempoolWsMessage {
  "address-transactions"?: MempoolAddressTransaction[];
  "track-address"?: string;
  [key: string]: unknown;
}

export interface MempoolAddressTransaction {
  txid: string;
  version: number;
  locktime: number;
  vin: Array<{
    txid: string;
    vout: number;
    prevout: {
      scriptpubkey: string;
      scriptpubkey_asm: string;
      scriptpubkey_type: string;
      scriptpubkey_address?: string;
      value: number;
    } | null;
    scriptsig: string;
    scriptsig_asm: string;
    witness?: string[];
    is_coinbase: boolean;
    sequence: number;
  }>;
  vout: Array<{
    scriptpubkey: string;
    scriptpubkey_asm: string;
    scriptpubkey_type: string;
    scriptpubkey_address?: string;
    value: number;
  }>;
  size: number;
  weight: number;
  fee: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

/**
 * Serialized deposit for storage
 */
export interface SerializedDeposit {
  id: string;
  taprootAddress: string;
  nullifier: string;
  secret: string;
  amount: string; // bigint as string
  claimLink: string;
  status: DepositStatus;
  confirmations: number;
  requiredConfirmations: number;
  txid?: string;
  vout?: number;
  detectedAmount?: number;
  blockHeight?: number;
  blockHash?: string;
  leafIndex?: number;
  commitment?: string;
  createdAt: number;
  detectedAt?: number;
  confirmedAt?: number;
  verifiedAt?: number;
  claimedAt?: number;
  error?: string;
  lastErrorAt?: number;
}

/**
 * Convert PendingDeposit to serializable format
 */
export function serializeDeposit(deposit: PendingDeposit): SerializedDeposit {
  return {
    ...deposit,
    amount: deposit.amount.toString(),
  };
}

/**
 * Convert serialized deposit back to PendingDeposit
 */
export function deserializeDeposit(data: SerializedDeposit): PendingDeposit {
  return {
    ...data,
    amount: BigInt(data.amount),
  };
}

/**
 * Generate a unique ID for a deposit using cryptographically secure random
 */
export function generateDepositId(): string {
  const timestamp = Date.now().toString(36);
  // Use crypto.getRandomValues for unpredictable random bytes
  const randomBytes = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  const random = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `dep_${timestamp}_${random}`;
}
