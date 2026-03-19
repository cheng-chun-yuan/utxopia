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
  // Redemption (Backend Required)
  REDEEM: "/api/redeem",
  WITHDRAWAL_STATUS: (id: string) => `/api/withdrawal/status/${encodeURIComponent(id)}`,

  // Block header status (Next.js API route -> Solana RPC)
  HEADER_STATUS: (height: number) => `/api/header/status/${height}`,
} as const;

export const DEFAULT_API_URL = "http://localhost:3001";

/**
 * Get the backend API URL from environment.
 * Standardizes 4 different env var names into one function.
 *
 * Server-side: TRACKER_API_URL > BACKEND_URL > default
 * Client-side: NEXT_PUBLIC_ZKBTC_API_URL > NEXT_PUBLIC_BACKEND_URL > default
 */
export function getBackendUrl(): string {
  if (typeof window === "undefined") {
    // Server-side
    return process.env.TRACKER_API_URL
      || process.env.BACKEND_URL
      || DEFAULT_API_URL;
  }
  // Client-side
  return process.env.NEXT_PUBLIC_ZKBTC_API_URL
    || process.env.NEXT_PUBLIC_BACKEND_URL
    || DEFAULT_API_URL;
}
