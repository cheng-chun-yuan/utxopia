/**
 * API Constants
 *
 * Minimal endpoints for backend communication:
 * - Redemption (BTC withdrawal) - requires server-side BTC signing
 * - Header status - checks on-chain header existence
 *
 * Note: Deposit/claim operations use SDK directly (no backend API)
 * Note: Header submission uses the backend header-relayer service (batch only)
 */

export const API_ENDPOINTS = {
  // Unified relay endpoint (all JoinSplit modes: transfer, unshield, redeem)
  RELAY: "/api/relay",
  WITHDRAWAL_STATUS: (id: string) => `/api/withdrawal/status/${encodeURIComponent(id)}`,

  // Block header status (Next.js API route -> Solana RPC)
  HEADER_STATUS: (height: number) => `/api/header/status/${height}`,
  PUBLIC_ZKBTC_BALANCE: (owner: string) =>
    `/api/public-zkbtc-balance?owner=${encodeURIComponent(owner)}`,
} as const;

import { getNetworkConfig, type NetworkId } from "../network-config";

export const DEFAULT_API_URL = "http://localhost:3001";

/** Default Solana RPC URL used when no env var or Helius key is configured */
export const SOLANA_RPC_FALLBACK_URL = "https://api.devnet.solana.com";

/**
 * Get the Solana RPC URL.
 *
 * Priority: NEXT_PUBLIC_SOLANA_RPC_URL env var > devnet fallback
 */
export function getSolanaRpcUrl(): string {
  return process.env.NEXT_PUBLIC_SOLANA_RPC_URL || SOLANA_RPC_FALLBACK_URL;
}

/**
 * Get the backend API URL.
 *
 * Pass an explicit `network` to resolve a specific stack (used by server-side
 * API routes that read the network from a request cookie via
 * `detectNetworkFromRequest`). Without it we use the build-time / browser-
 * detected default.
 *
 * Priority: env var override > networks.json[network] > localhost fallback
 */
export function getBackendUrl(network?: NetworkId): string {
  const cfgUrl = getNetworkConfig(network).backend.url;
  if (typeof window === "undefined") {
    return process.env.BACKEND_API_URL || cfgUrl || DEFAULT_API_URL;
  }
  return process.env.NEXT_PUBLIC_BACKEND_API_URL || cfgUrl || DEFAULT_API_URL;
}
