/**
 * Token Context — manages the currently selected token for the multi-token shielded pool.
 *
 * All components use getActiveTokenId() instead of hardcoded ZKBTC_TOKEN_ID.
 * Supports switching between whitelisted tokens.
 */

import { getConfig, computeTokenId } from "@aegis/sdk";
import { PublicKey } from "@solana/web3.js";

// ============================================================================
// Active Token State
// ============================================================================

/** Currently selected token mint address (base58) */
let activeTokenMint: string | null = null;

/** Cached token_id for the active token */
let cachedTokenId: bigint | null = null;

/** Registered tokens cache */
let registeredTokens: TokenInfo[] = [];

export interface TokenInfo {
  /** Display name */
  name: string;
  /** Token symbol */
  symbol: string;
  /** SPL mint address (base58) */
  mint: string;
  /** Token decimals */
  decimals: number;
  /** Computed token_id for circuit use */
  tokenId: bigint;
  /** Mint pubkey as raw bytes */
  mintBytes: Uint8Array;
}

// ============================================================================
// Getters
// ============================================================================

/**
 * Get the active token's token_id (for Poseidon commitments).
 * Defaults to zkBTC if no token is selected.
 */
export function getActiveTokenId(): bigint {
  if (cachedTokenId !== null) return cachedTokenId;

  // Default: compute from zkBTC mint in config
  const config = getConfig();
  const mintBytes = new PublicKey(config.zkbtcMint).toBytes();
  cachedTokenId = computeTokenId(mintBytes);
  activeTokenMint = config.zkbtcMint;
  return cachedTokenId;
}

/**
 * Get the active token's mint address (base58).
 */
export function getActiveTokenMint(): string {
  if (activeTokenMint) return activeTokenMint;
  getActiveTokenId(); // triggers default initialization
  return activeTokenMint!;
}

/**
 * Get the active token's mint as raw bytes.
 */
export function getActiveTokenMintBytes(): Uint8Array {
  return new PublicKey(getActiveTokenMint()).toBytes();
}

/**
 * Get all registered tokens.
 */
export function getRegisteredTokens(): TokenInfo[] {
  return registeredTokens;
}

// ============================================================================
// Setters
// ============================================================================

/**
 * Switch the active token by mint address.
 */
export function setActiveToken(mint: string): void {
  const mintBytes = new PublicKey(mint).toBytes();
  activeTokenMint = mint;
  cachedTokenId = computeTokenId(mintBytes);
}

/**
 * Register a token (called on app init after fetching from chain).
 */
export function registerToken(info: TokenInfo): void {
  // Avoid duplicates
  if (!registeredTokens.find(t => t.mint === info.mint)) {
    registeredTokens.push(info);
  }
}

/**
 * Register zkBTC as the default token from config.
 */
export function registerDefaultToken(): void {
  const config = getConfig();
  const mintBytes = new PublicKey(config.zkbtcMint).toBytes();
  const tokenId = computeTokenId(mintBytes);

  registerToken({
    name: "Aegis Shielded BTC",
    symbol: "zkBTC",
    mint: config.zkbtcMint,
    decimals: 0, // satoshis
    tokenId,
    mintBytes,
  });

  // Set as active if nothing selected
  if (!activeTokenMint) {
    activeTokenMint = config.zkbtcMint;
    cachedTokenId = tokenId;
  }
}

/**
 * Clear all state (for testing/reset).
 */
export function resetTokenContext(): void {
  activeTokenMint = null;
  cachedTokenId = null;
  registeredTokens = [];
}
