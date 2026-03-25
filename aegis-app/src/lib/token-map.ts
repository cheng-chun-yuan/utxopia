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
  // zkBTC mint: 5m3bbj8tzvGfS1ikv4zxa6zraFUVnff5yYWM51wCDQjB
  "019b79fd89c3f11729f30df6229b932742d6030efe264abd774a3c8fc83e7165": "BTC",
  // wSOL (native) mint: So11111111111111111111111111111111111111112
  "2c1de4dadda2901001910aa8c4f8ea56c51a5a5b2d156a50003d9a3cd3801cae": "SOL",
  // USDC mint: HyzNNEUL3W2dyPGrZJ2XcpoASdQL99Smxz2yyBqJ8yj1
  "0fe717580e6af5dc1051f06fd7c697e4a11e388d221640814a6eb998806abb8f": "USDC",
  // USDT mint: EpvkQMMuqHQH1HajcD74WyabzjNxjJW53xtBpnHUwgQv
  "06db61dd810e2589eb944051114416b9e99181408c52de9b73088cf19653cbb8": "USDT",
  // jupUSD mint: 2Z82qqmoJsb5gtVzpHBYJrsmLPpV83VRG1aCqp2onG7t
  "06013329f547d34ba63bc7dca2634fc8054748e00143db21c8865566b38bb94b": "jupUSD",
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
