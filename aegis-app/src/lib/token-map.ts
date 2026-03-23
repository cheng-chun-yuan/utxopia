/**
 * Shared token ID → symbol resolution.
 *
 * Single source of truth for mapping on-chain token IDs (Poseidon hash of mint)
 * to human-readable symbols. Used by API routes (deposits, transfers) and
 * frontend hooks.
 *
 * Token metadata lives in supported-tokens.ts. This module just computes
 * the Poseidon(mint) → symbol mapping.
 *
 * @module token-map
 */

import { SUPPORTED_TOKENS } from "./supported-tokens";

/**
 * Build a tokenIdHex → symbol map from SUPPORTED_TOKENS.
 *
 * Requires Poseidon to be initialized (calls initPoseidon internally).
 * Safe to call multiple times — caches after first build.
 *
 * Flow:
 *   supported-tokens.ts (symbol + mint)
 *        ↓
 *   SDK computeTokenId(mintBytes)  →  Poseidon(reduceToField(mint), 0)
 *        ↓
 *   Map<tokenIdHex, symbol>
 */
let cachedMap: Map<string, string> | null = null;

export async function buildTokenIdMap(): Promise<Map<string, string>> {
  if (cachedMap) return cachedMap;

  const map = new Map<string, string>();

  try {
    const { computeTokenId, initPoseidon, getConfig } = await import("@aegis/sdk");
    const { PublicKey } = await import("@solana/web3.js");
    await initPoseidon();

    // Resolve zkBTC mint from SDK config (supported-tokens.ts leaves it empty)
    const zkbtcMint = getConfig().zkbtcMint;

    for (const token of SUPPORTED_TOKENS) {
      // Skip tokens without a mint (BTC native has no SPL mint)
      let mintAddress = token.mint;
      if (!mintAddress && (token.symbol === "BTC" || token.symbol === "zkBTC")) {
        mintAddress = zkbtcMint;
      }
      if (!mintAddress) continue;

      try {
        const mintBytes = new PublicKey(mintAddress).toBytes();
        const tokenId = computeTokenId(mintBytes);
        const hex = tokenId.toString(16).padStart(64, "0");
        map.set(hex, token.symbol);
      } catch {
        // Skip invalid mints (e.g. empty env var)
      }
    }
  } catch (err) {
    console.error("[token-map] Failed to build token ID map:", err);
  }

  if (map.size > 0) cachedMap = map;
  return map;
}

/** Resolve a tokenIdHex to a symbol. Returns null if unknown. */
export async function resolveTokenSymbol(tokenIdHex: string): Promise<string | null> {
  const map = await buildTokenIdMap();
  return map.get(tokenIdHex.toLowerCase()) ?? map.get(tokenIdHex) ?? null;
}
