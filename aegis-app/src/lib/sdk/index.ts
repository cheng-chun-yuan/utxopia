/**
 * SDK Service Layer
 *
 * Frontend-friendly wrapper around @aegis/sdk.
 * Provides simplified interfaces for deposit, claim, and split operations.
 *
 * Architecture:
 * - Deposit: SDK generates note + derives taproot address
 * - Claim: Client generates ZK proof, submits directly to Solana
 * - Split: Client generates ZK proof, submits directly to Solana
 * - Withdraw: Only operation requiring backend (BTC signing)
 */

import {
  generateNote,
  deriveNote,
  deriveTaprootAddress,
  serializeNote,
  deserializeNote,
  encodeClaimLink,
  decodeClaimLink,
  esploraTestnet,
  initPoseidon,
  type Note,
  type SerializedNote,
  type EsploraAddressInfo,
  type EsploraTransaction,
} from "@aegis/sdk";

// Re-export commonly used types and functions
export {
  generateNote,
  deriveNote,
  deriveTaprootAddress,
  serializeNote,
  deserializeNote,
  encodeClaimLink,
  decodeClaimLink,
  initPoseidon,
  type Note,
  type SerializedNote,
};

/**
 * Create deposit from a seed phrase (user's secret note)
 * This is the preferred method - generates shorter claim links!
 *
 * @param seed - User's secret phrase (e.g., "alpha-bravo-charlie-1234")
 * @param network - Bitcoin network
 * @param baseUrl - Base URL for claim links
 * @returns Deposit credentials with short claim link
 */
export async function createDepositFromSeed(
  seed: string,
  network: "testnet" | "mainnet" = "testnet",
  baseUrl?: string
): Promise<DepositCredentials> {
  await initPoseidon();

  // Derive note from seed (nullifier + secret derived deterministically)
  const note = deriveNote(seed, 0, BigInt(0)); // Amount is 0 - determined by actual deposit

  // Derive taproot address from commitment
  const { address: taprootAddress } = await deriveTaprootAddress(
    note.commitmentBytes,
    network
  );

  // Claim link = just the seed itself (URL-encoded)
  const claimLink = encodeClaimLink(seed);

  const base = baseUrl || (typeof window !== "undefined" ? window.location.origin : "https://zkbtc.app");
  const claimUrl = `${base}/claim#note=${claimLink}`;

  const serializedNote = serializeNote(note);

  return {
    note,
    serializedNote,
    taprootAddress,
    claimLink,
    claimUrl,
  };
}

// =============================================================================
// Deposit Types
// =============================================================================

export interface DepositCredentials {
  /** Generated note with nullifier, secret, amount */
  note: Note;
  /** Serialized note for storage */
  serializedNote: SerializedNote;
  /** Taproot address (tb1p... or bc1p...) */
  taprootAddress: string;
  /** Claim link URL-safe encoded string */
  claimLink: string;
  /** Full claim URL */
  claimUrl: string;
}

export interface DepositStatus {
  found: boolean;
  address: string;
  amountSats?: number;
  txid?: string;
  confirmations: number;
  canClaim: boolean;
}

// =============================================================================
// Deposit Functions
// =============================================================================


// =============================================================================
// Deposit Status Functions (via Esplora)
// =============================================================================

/** Required confirmations before claiming */
const REQUIRED_CONFIRMATIONS = 2;

/**
 * Check deposit status by querying Bitcoin network directly.
 *
 * Uses Esplora API (mempool.space) to check:
 * - If any transactions received at the address
 * - Confirmation count
 * - Whether claim threshold is met
 *
 * @param taprootAddress - Bitcoin taproot address (tb1p... or bc1p...)
 * @returns Deposit status
 */
export async function checkDepositStatus(
  taprootAddress: string
): Promise<DepositStatus> {
  try {
    // Get address info
    const addressInfo: EsploraAddressInfo = await esploraTestnet.getAddress(taprootAddress);

    const totalReceived =
      addressInfo.chain_stats.funded_txo_sum +
      addressInfo.mempool_stats.funded_txo_sum;

    if (totalReceived === 0) {
      return {
        found: false,
        address: taprootAddress,
        confirmations: 0,
        canClaim: false,
      };
    }

    // Get transactions to find deposit details
    const txs: EsploraTransaction[] = await esploraTestnet.getAddressTxs(taprootAddress);

    // Find incoming transaction to this address
    let depositTx: EsploraTransaction | null = null;
    let depositAmount = 0;

    for (const tx of txs) {
      for (const vout of tx.vout) {
        if (vout.scriptpubkey_address === taprootAddress) {
          depositTx = tx;
          depositAmount = vout.value;
          break;
        }
      }
      if (depositTx) break;
    }

    if (!depositTx) {
      return {
        found: false,
        address: taprootAddress,
        confirmations: 0,
        canClaim: false,
      };
    }

    // Calculate confirmations
    let confirmations = 0;
    if (depositTx.status.confirmed && depositTx.status.block_height) {
      const tipHeight = await esploraTestnet.getBlockHeight();
      confirmations = tipHeight - depositTx.status.block_height + 1;
    }

    const canClaim = confirmations >= REQUIRED_CONFIRMATIONS;

    return {
      found: true,
      address: taprootAddress,
      amountSats: depositAmount,
      txid: depositTx.txid,
      confirmations,
      canClaim,
    };
  } catch (error) {
    console.error("Failed to check deposit status:", error);
    return {
      found: false,
      address: taprootAddress,
      confirmations: 0,
      canClaim: false,
    };
  }
}

// =============================================================================
// Claim Link Functions
// =============================================================================

/**
 * Parse a claim link and extract note data.
 *
 * Supports multiple formats:
 * - Fragment: #note=<url-encoded-seed> (preferred, not sent to server)
 * - Query: ?note=<url-encoded-seed> (legacy)
 * - Full URL: https://example.com/claim#note=<base64>
 * - Raw base64: <base64>
 * - Legacy format: ?n=<nullifier>&s=<secret>
 *
 * @param link - Claim link in any supported format
 * @returns Nullifier and secret, or null if invalid
 */
export function parseClaimLinkData(
  link: string
): { nullifier: string; secret: string } | null {
  // Helper to convert seed to { nullifier, secret }
  const seedToNullifierSecret = (seed: string): { nullifier: string; secret: string } => {
    const note = deriveNote(seed, 0, BigInt(0));
    return { nullifier: note.nullifier.toString(), secret: note.secret.toString() };
  };

  // Try SDK's decoder
  const result = decodeClaimLink(link);
  if (result) {
    if (typeof result === "string") {
      return seedToNullifierSecret(result);
    }
    return result;
  }

  // Try extracting from URL
  if (link.includes("note=")) {
    const match = link.match(/note=([^&#\s]+)/);
    if (match) {
      const decoded = decodeClaimLink(match[1]);
      if (decoded) {
        if (typeof decoded === "string") {
          return seedToNullifierSecret(decoded);
        }
        return decoded;
      }
    }
  }

  // Try legacy format: ?n=<nullifier>&s=<secret>
  if (link.includes("n=") && link.includes("s=")) {
    const params = new URLSearchParams(link.includes("?") ? link.split("?")[1] : link);
    const n = params.get("n");
    const s = params.get("s");
    if (n && s) {
      return { nullifier: n, secret: s };
    }
  }

  return null;
}

/**
 * Reconstruct a Note from claim link data.
 *
 * NOTE: Amount must be provided or fetched from on-chain state
 * since claim links may not include amount.
 *
 * @param nullifier - Nullifier string
 * @param secret - Secret string
 * @param amountSats - Amount in satoshis
 * @returns Reconstructed Note
 */
export function reconstructNote(
  nullifier: string,
  secret: string,
  amountSats: bigint
): Note {
  const serialized: SerializedNote = {
    nullifier,
    secret,
    amount: amountSats.toString(),
  };
  return deserializeNote(serialized);
}

// =============================================================================
// Utility Exports
// =============================================================================

export { esploraTestnet };

export const REQUIRED_CONFIRMATIONS_VALUE = REQUIRED_CONFIRMATIONS;
