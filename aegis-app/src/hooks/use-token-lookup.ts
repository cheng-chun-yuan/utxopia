"use client";

import { useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { computeTokenId, getConfig } from "@aegis/sdk";
import { SUPPORTED_TOKENS, type SupportedToken } from "@/lib/supported-tokens";

/**
 * Hook that builds a tokenId (hex) → SupportedToken lookup map.
 * Computes Poseidon(mint_bytes) for each token with a known mint address.
 */
export function useTokenLookup(): Map<string, SupportedToken> {
  return useMemo(() => {
    const map = new Map<string, SupportedToken>();
    const config = getConfig();

    for (const token of SUPPORTED_TOKENS) {
      try {
        let mintAddr = token.mint;
        // Resolve runtime mints
        if (!mintAddr && (token.symbol === "zkBTC" || token.symbol === "BTC")) {
          mintAddr = config.zkbtcMint;
        }
        if (!mintAddr) continue;

        const mintBytes = new PublicKey(mintAddr).toBytes();
        const tokenId = computeTokenId(mintBytes);
        const hex = tokenId.toString(16).padStart(64, "0");
        map.set(hex, token);
      } catch {
        // Skip tokens with invalid/missing mints
      }
    }
    return map;
  }, []);
}

/**
 * Look up a SupportedToken by its tokenId hex string.
 * Falls back to BTC config if not found.
 */
export function lookupTokenByIdHex(
  map: Map<string, SupportedToken>,
  tokenIdHex: string | undefined,
): SupportedToken {
  if (!tokenIdHex) return SUPPORTED_TOKENS[0]; // fallback to BTC
  const token = map.get(tokenIdHex.toLowerCase());
  return token ?? SUPPORTED_TOKENS[0];
}
