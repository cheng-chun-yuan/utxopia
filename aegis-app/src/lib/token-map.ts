/**
 * Shared token ID → symbol resolution.
 *
 * Token IDs are Poseidon(reduceToField(mint), 0) — deterministic and
 * never change for a given mint. We precompute them for known devnet
 * mints so the map works even if Poseidon fails to init on Vercel.
 *
 * @module token-map
 */

import { SUPPORTED_TOKENS } from "./supported-tokens";

// ---------------------------------------------------------------------------
// Precomputed token IDs for known devnet mints
// These are Poseidon(reduceToField(mintPubkey), 0) — deterministic.
// Regenerate: bun -e "..." (see seed-stealth-deposits.ts)
// ---------------------------------------------------------------------------

export const KNOWN_TOKEN_IDS: Record<string, string> = {
  // zkBTC mint: DV7Do8f7rKXehVXDSkuKi7pMwfHUeoKGcpHfnvAd5oUh
  "0b0fe8dabc30b12b737303a7a36e7538a90499466e484d1fdeef1cbadf08a47e": "BTC",
  // wSOL mint: 9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP
  "01cd412855fd43094d07876f980158abfba2a21f13fd9dbca940a7a204ed5a7a": "SOL",
  // tUSDC mint: 6eD9uhGpUtZ8dciNR5RF4yvH5sLDpHnWmCRhDh2CTCVV
  "2ec04019262b079aaf7458e3216a3e5efc63ab0bbc61616f4d9984ecb6eb78dd": "USDC",
  // tUSDT mint: CnqLMZ2DaKYgKXFp4huJmzZA57xyZjWFt97Vigf176Ld
  "248334e6ea3119ca0c7a5b68bc69ce3834cb84f5f5c67b0298d03d254de6b8e8": "USDT",
};

// ---------------------------------------------------------------------------
// Build token map — tries Poseidon first, falls back to precomputed
// ---------------------------------------------------------------------------

let cachedMap: Map<string, string> | null = null;

export async function buildTokenIdMap(): Promise<Map<string, string>> {
  if (cachedMap) return cachedMap;

  const map = new Map<string, string>();

  // Always load precomputed fallback first
  for (const [id, sym] of Object.entries(KNOWN_TOKEN_IDS)) {
    map.set(id, sym);
  }

  // Try Poseidon for any additional mints (env-specified localnet mints, etc.)
  try {
    const { computeTokenId, initPoseidon, getConfig } = await import("@aegis/sdk");
    const { PublicKey } = await import("@solana/web3.js");
    await initPoseidon();

    const zkbtcMint = getConfig().zkbtcMint;

    for (const token of SUPPORTED_TOKENS) {
      let mintAddress = token.mint;
      if (!mintAddress && (token.symbol === "BTC" || token.symbol === "zkBTC")) {
        mintAddress = zkbtcMint;
      }
      if (!mintAddress) continue;

      try {
        const mintBytes = new PublicKey(mintAddress).toBytes();
        const tokenId = computeTokenId(mintBytes);
        const hex = tokenId.toString(16).padStart(64, "0");
        if (!map.has(hex)) map.set(hex, token.symbol);
      } catch { /* skip */ }
    }
  } catch {
    // Poseidon failed — precomputed fallback already loaded
  }

  if (map.size > 0) cachedMap = map;
  return map;
}

/** Resolve a tokenIdHex to a symbol. Returns null if unknown. */
export async function resolveTokenSymbol(tokenIdHex: string): Promise<string | null> {
  const map = await buildTokenIdMap();
  return map.get(tokenIdHex.toLowerCase()) ?? map.get(tokenIdHex) ?? null;
}

/** Sync resolve — uses cached map if available, falls back to precomputed.
 * Call buildTokenIdMap() once at startup to populate the cache with localnet mints. */
export function resolveTokenSymbolSync(tokenIdHex: string): string | null {
  const hex = tokenIdHex.toLowerCase();
  if (cachedMap) {
    return cachedMap.get(hex) ?? cachedMap.get(tokenIdHex) ?? null;
  }
  return KNOWN_TOKEN_IDS[hex] ?? KNOWN_TOKEN_IDS[tokenIdHex] ?? null;
}
