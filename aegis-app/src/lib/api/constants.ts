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
} as const;

import { getNetworkConfig } from "../network-config";

export const DEFAULT_API_URL = "http://localhost:3001";

/**
 * Get the backend API URL.
 *
 * Priority: env var override > config/networks.json > localhost fallback
 */
export function getBackendUrl(): string {
  const cfgUrl = getNetworkConfig().backend.url;
  if (typeof window === "undefined") {
    return process.env.BACKEND_API_URL || cfgUrl || DEFAULT_API_URL;
  }
  return process.env.NEXT_PUBLIC_BACKEND_API_URL || cfgUrl || DEFAULT_API_URL;
}
