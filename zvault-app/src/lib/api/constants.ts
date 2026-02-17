/**
 * API Constants
 *
 * Minimal endpoints for backend communication:
 * - Redemption (BTC withdrawal) - requires server-side BTC signing
 * - Header submission - uses Next.js API routes (proxied to relayer)
 *
 * Note: Deposit/claim operations use SDK directly (no backend API)
 */

export const API_ENDPOINTS = {
  // Redemption (Backend Required)
  REDEEM: "/api/redeem",
  WITHDRAWAL_STATUS: (id: string) => `/api/withdrawal/status/${encodeURIComponent(id)}`,

  // Block header submission (Next.js API routes -> header-relayer)
  SUBMIT_HEADER: "/api/header/submit",
  HEADER_STATUS: (height: number) => `/api/header/status/${height}`,
} as const;

export const DEFAULT_API_URL = "http://localhost:3001";
