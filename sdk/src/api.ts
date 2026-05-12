/**
 * UTXOpia Simplified API (JoinSplit Architecture)
 *
 * DEPOSIT (BTC -> zkBTC):
 * - depositToNote: Generate deposit credentials (taproot address + claim link)
 *
 * All transfers and withdrawals use the JoinSplit transact instruction
 * via buildTransactInstruction() from the instructions module.
 *
 * @module api
 */

import {
  type Address,
} from "@solana/kit";

import { generateNote, computeNoteCommitment, type Note, formatBtc } from "./note";
import { deriveTaprootAddress } from "./taproot";
import { encodeClaimLink } from "./claim-link";

// ============================================================================
// Types
// ============================================================================

/**
 * Result from depositToNote() - credentials needed to receive BTC
 */
export interface DepositResult {
  /** Note containing secrets (save this!) */
  note: Note;
  /** Bitcoin address to send BTC to */
  taprootAddress: string;
  /** Shareable claim link (contains secrets) */
  claimLink: string;
  /** Human-readable amount */
  displayAmount: string;
}

/**
 * Signer interface for v2 transactions
 */
export interface TransactionSigner {
  address: Address;
  signTransaction: <T extends { signatures: Record<string, Uint8Array> }>(transaction: T) => Promise<T>;
}

/**
 * RPC interface for sending transactions
 */
export interface RpcClient {
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  sendTransaction: (transaction: Uint8Array) => Promise<string>;
  confirmTransaction: (signature: string) => Promise<void>;
  simulateTransaction?: (transaction: Uint8Array) => Promise<{ err: unknown | null; logs?: string[] }>;
}

/**
 * Client configuration
 */
export interface ApiClientConfig {
  rpc: RpcClient;
  programId: Address;
  payer?: TransactionSigner;
}

// ============================================================================
// Constants
// ============================================================================

/** Default program ID (Solana Devnet) - imported from pda.ts */
export { UTXOPIA_PROGRAM_ID as DEFAULT_PROGRAM_ID } from "./pda";

/** Maximum BTC supply in satoshis (21 million BTC) */
const MAX_SATS = 21_000_000n * 100_000_000n;

/** Minimum dust amount (546 sats - Bitcoin dust limit) */
const MIN_DUST_SATS = 546n;

/**
 * Validate amount in satoshis
 * @throws Error if amount is invalid
 */
function validateAmount(amountSats: bigint, context: string): void {
  if (amountSats <= 0n) {
    throw new Error(`${context}: Amount must be positive`);
  }
  if (amountSats < MIN_DUST_SATS) {
    throw new Error(`${context}: Amount ${amountSats} sats is below dust limit (${MIN_DUST_SATS} sats)`);
  }
  if (amountSats > MAX_SATS) {
    throw new Error(`${context}: Amount exceeds maximum BTC supply`);
  }
}

// ============================================================================
// DEPOSIT
// ============================================================================

/**
 * Generate deposit credentials (creates a claim link)
 *
 * Creates a new note with random secrets, derives a taproot address for
 * receiving BTC, and creates a claim link for later claiming.
 *
 * **Flow:**
 * 1. Generate random nullifier + secret
 * 2. Derive taproot address from commitment
 * 3. Create claim link with encoded secrets
 * 4. User sends BTC to taproot address externally
 * 5. Later: backend verifies deposit via SPV + stealth announcement
 *
 * @param amountSats - Amount in satoshis (must be > 546 sats dust limit)
 * @param network - Bitcoin network (mainnet/testnet)
 * @param baseUrl - Base URL for claim link
 * @returns Deposit credentials with claim link
 */
export async function depositToNote(
  amountSats: bigint,
  network: "mainnet" | "testnet" = "testnet",
  baseUrl?: string
): Promise<DepositResult> {
  validateAmount(amountSats, "depositToNote");

  let note = generateNote(amountSats);
  note = computeNoteCommitment(note);

  const { address: taprootAddress } = await deriveTaprootAddress(
    note.commitmentBytes,
    network
  );

  // Encode nullifier+secret as claim link
  const claimLink = `${baseUrl || "https://utxopia.app"}/claim#note=${encodeClaimLink(
    `${note.nullifier.toString(16)}.${note.secret.toString(16)}`
  )}`;

  return {
    note,
    taprootAddress,
    claimLink,
    displayAmount: formatBtc(amountSats),
  };
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export { generateNote, createNoteFromSecrets, deriveNote, deriveNotes, estimateSeedStrength } from "./note";
export { parseClaimUrl } from "./claim-link";
export {
  scanAnnouncements,
  prepareClaimInputs,
  isWalletAdapter,
} from "./stealth";
export type { Note } from "./note";
export type { MerkleProof } from "./merkle";
export type { StealthDeposit, ScannedNote, ClaimInputs } from "./stealth";
export type { StealthMetaAddress, UTXOpiaKeys } from "./keys";
