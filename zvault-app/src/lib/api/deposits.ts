/**
 * Deposit Tracker API Client
 *
 * Provides interface to the backend deposit tracker service:
 * - POST /api/deposits - Register deposit to track
 * - GET /api/deposits/:id - Get deposit status
 * - WebSocket /ws/deposits/:id - Subscribe to real-time updates
 */

import { ApiError } from "./errors";

// API base URL for deposit tracker
const getTrackerApiUrl = () =>
  process.env.NEXT_PUBLIC_TRACKER_API_URL ||
  process.env.NEXT_PUBLIC_ZKBTC_API_URL ||
  "http://localhost:3001";

// =============================================================================
// Types
// =============================================================================

export type DepositStatus =
  | "pending"
  | "detected"
  | "confirming"
  | "confirmed"
  | "sweeping"
  | "sweep_confirming"
  | "verifying"
  | "ready"
  | "claimed"
  | "failed";

export interface RegisterDepositRequest {
  taproot_address: string;
  commitment: string;
  amount_sats: number;
  claim_link?: string;
}

export interface RegisterDepositResponse {
  success: boolean;
  deposit_id?: string;
  message?: string;
}

export interface DepositStatusResponse {
  id: string;
  status: DepositStatus;
  confirmations: number;
  can_claim: boolean;
  btc_txid?: string;
  sweep_txid?: string;
  sweep_confirmations: number;
  solana_tx?: string;
  leaf_index?: number;
  error?: string;
  created_at: number;
  updated_at: number;
}

export interface DepositStatusUpdate {
  deposit_id: string;
  status: DepositStatus;
  confirmations: number;
  sweep_confirmations: number;
  can_claim: boolean;
  error?: string;
}

// =============================================================================
// Stealth Deposit Types
// =============================================================================

export type StealthDepositStatus =
  | "pending"
  | "detected"
  | "confirming"
  | "confirmed"
  | "sweeping"
  | "sweep_confirming"
  | "verifying"
  | "ready"
  | "failed";

export interface PrepareStealthDepositRequest {
  viewing_pub: string;
  spending_pub: string;
}

export interface PrepareStealthDepositResponse {
  success: boolean;
  deposit_id?: string;
  btc_address?: string;
  ephemeral_pub?: string;
  expires_at?: number;
  error?: string;
}

export interface StealthDepositStatusResponse {
  id: string;
  status: StealthDepositStatus;
  btc_address: string;
  ephemeral_pub: string;
  actual_amount_sats?: number;
  confirmations: number;
  sweep_confirmations: number;
  deposit_txid?: string;
  sweep_txid?: string;
  solana_tx?: string;
  leaf_index?: number;
  error?: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface StealthDepositStatusUpdate {
  deposit_id: string;
  status: StealthDepositStatus;
  actual_amount_sats?: number;
  confirmations: number;
  sweep_confirmations: number;
  is_ready: boolean;
  error?: string;
}

// =============================================================================
// API Functions
// =============================================================================

/**
 * Register a deposit for tracking
 *
 * @param taprootAddress - The Bitcoin taproot address
 * @param commitment - The SHA256(nullifier || secret) commitment (64 hex chars)
 * @param amountSats - Expected amount in satoshis
 * @param claimLink - Optional claim link for reference
 */
export async function registerDeposit(
  taprootAddress: string,
  commitment: string,
  amountSats: number,
  claimLink?: string
): Promise<RegisterDepositResponse> {
  const body: RegisterDepositRequest = {
    taproot_address: taprootAddress,
    commitment,
    amount_sats: amountSats,
    claim_link: claimLink,
  };

  const response = await fetch(`${getTrackerApiUrl()}/api/deposits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: `HTTP ${response.status}: ${response.statusText}`,
    }));
    throw ApiError.fromResponse(error, response.status);
  }

  return response.json();
}

/**
 * Get deposit status by ID
 *
 * @param depositId - The deposit ID returned from registerDeposit
 */
export async function getDepositStatus(
  depositId: string
): Promise<DepositStatusResponse> {
  const response = await fetch(
    `${getTrackerApiUrl()}/api/deposits/${depositId}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: `HTTP ${response.status}: ${response.statusText}`,
    }));
    throw ApiError.fromResponse(error, response.status);
  }

  return response.json();
}

// =============================================================================
// Stealth Deposit API Functions
// =============================================================================

/**
 * Prepare a stealth deposit address
 *
 * @param viewingPub - User's viewing public key (66 hex chars)
 * @param spendingPub - User's spending public key (66 hex chars)
 */
export async function prepareStealthDeposit(
  viewingPub: string,
  spendingPub: string
): Promise<PrepareStealthDepositResponse> {
  const body: PrepareStealthDepositRequest = {
    viewing_pub: viewingPub,
    spending_pub: spendingPub,
  };

  const response = await fetch(`${getTrackerApiUrl()}/api/stealth/prepare`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: `HTTP ${response.status}: ${response.statusText}`,
    }));
    throw ApiError.fromResponse(error, response.status);
  }

  return response.json();
}

/**
 * Get stealth deposit status by ID
 *
 * @param depositId - The deposit ID returned from prepareStealthDeposit
 */
export async function getStealthDepositStatus(
  depositId: string
): Promise<StealthDepositStatusResponse> {
  const response = await fetch(
    `${getTrackerApiUrl()}/api/stealth/${depositId}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: `HTTP ${response.status}: ${response.statusText}`,
    }));
    throw ApiError.fromResponse(error, response.status);
  }

  return response.json();
}

/**
 * Subscribe to stealth deposit status updates via WebSocket
 */
export function subscribeToStealthDeposit(
  depositId: string,
  options: {
    onStatusUpdate: (update: StealthDepositStatusUpdate) => void;
    onError?: (error: Event) => void;
    onClose?: (event: CloseEvent) => void;
    onOpen?: () => void;
  }
): { ws: WebSocket; unsubscribe: () => void } {
  const wsUrl = getTrackerApiUrl()
    .replace("http://", "ws://")
    .replace("https://", "wss://");

  const ws = new WebSocket(`${wsUrl}/ws/stealth/${depositId}`);

  ws.onmessage = (event) => {
    try {
      const update: StealthDepositStatusUpdate = JSON.parse(event.data);
      options.onStatusUpdate(update);
    } catch (e) {
      console.error("Failed to parse WebSocket message:", e);
    }
  };

  ws.onerror = (error) => {
    options.onError?.(error);
  };

  ws.onclose = (event) => {
    options.onClose?.(event);
  };

  ws.onopen = () => {
    options.onOpen?.();
  };

  return {
    ws,
    unsubscribe: () => {
      ws.close();
    },
  };
}

// =============================================================================
// WebSocket Connection
// =============================================================================

export interface DepositWebSocketOptions {
  onStatusUpdate: (update: DepositStatusUpdate) => void;
  onError?: (error: Event) => void;
  onClose?: (event: CloseEvent) => void;
  onOpen?: () => void;
}

/**
 * Create a WebSocket connection for deposit status updates
 *
 * @param depositId - The deposit ID to subscribe to
 * @param options - Callback handlers
 * @returns WebSocket instance and cleanup function
 */
export function subscribeToDepositStatus(
  depositId: string,
  options: DepositWebSocketOptions
): { ws: WebSocket; unsubscribe: () => void } {
  const wsUrl = getTrackerApiUrl()
    .replace("http://", "ws://")
    .replace("https://", "wss://");

  const ws = new WebSocket(`${wsUrl}/ws/deposits/${depositId}`);

  ws.onmessage = (event) => {
    try {
      const update: DepositStatusUpdate = JSON.parse(event.data);
      options.onStatusUpdate(update);
    } catch (e) {
      console.error("Failed to parse WebSocket message:", e);
    }
  };

  ws.onerror = (error) => {
    options.onError?.(error);
  };

  ws.onclose = (event) => {
    options.onClose?.(event);
  };

  ws.onopen = () => {
    options.onOpen?.();
  };

  return {
    ws,
    unsubscribe: () => {
      ws.close();
    },
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if a deposit status indicates it's still pending
 */
export function isDepositPending(status: DepositStatus): boolean {
  return ["pending", "detected", "confirming"].includes(status);
}

/**
 * Check if a deposit status indicates it's being processed
 */
export function isDepositProcessing(status: DepositStatus): boolean {
  return ["confirmed", "sweeping", "sweep_confirming", "verifying"].includes(
    status
  );
}

/**
 * Check if a deposit can be claimed
 */
export function isDepositClaimable(status: DepositStatus): boolean {
  return status === "ready";
}

/**
 * Check if a deposit is in a terminal state
 */
export function isDepositTerminal(status: DepositStatus): boolean {
  return ["claimed", "failed"].includes(status);
}

/**
 * Get human-readable status message
 */
export function getStatusMessage(status: DepositStatus): string {
  const messages: Record<DepositStatus, string> = {
    pending: "Waiting for BTC deposit",
    detected: "Deposit detected in mempool",
    confirming: "Waiting for confirmations",
    confirmed: "Deposit confirmed, preparing sweep",
    sweeping: "Sweeping to pool wallet",
    sweep_confirming: "Sweep transaction confirming",
    verifying: "Verifying on Solana",
    ready: "Ready to claim zkBTC",
    claimed: "zkBTC claimed successfully",
    failed: "Deposit failed",
  };

  return messages[status] || status;
}

/**
 * Get progress percentage for a deposit
 * Returns 0-100
 */
export function getDepositProgress(
  status: DepositStatus,
  confirmations: number,
  sweepConfirmations: number
): number {
  // Progress steps:
  // 0-10: pending
  // 10-50: confirming (1 confirmation for demo)
  // 50-70: sweeping + sweep_confirming (2 confirmations)
  // 70-90: verifying
  // 90-100: ready/claimed

  switch (status) {
    case "pending":
      return 5;
    case "detected":
      return 10;
    case "confirming":
      // 10 + (confirmations/1) * 40 = 10-50%
      return Math.min(50, 10 + Math.floor((confirmations / 1) * 40));
    case "confirmed":
      return 50;
    case "sweeping":
      return 55;
    case "sweep_confirming":
      // 55 + (sweepConfirmations/2) * 15 = 55-70%
      return Math.min(70, 55 + Math.floor((sweepConfirmations / 2) * 15));
    case "verifying":
      return 80;
    case "ready":
      return 95;
    case "claimed":
      return 100;
    case "failed":
      return 0;
    default:
      return 0;
  }
}

// =============================================================================
// Stealth Deposit Helpers
// =============================================================================

/**
 * Check if a stealth deposit is still pending BTC
 */
export function isStealthDepositPending(status: StealthDepositStatus): boolean {
  return ["pending", "detected", "confirming"].includes(status);
}

/**
 * Check if a stealth deposit is being processed
 */
export function isStealthDepositProcessing(
  status: StealthDepositStatus
): boolean {
  return ["confirmed", "sweeping", "sweep_confirming", "verifying"].includes(
    status
  );
}

/**
 * Check if a stealth deposit is ready (user can scan inbox)
 */
export function isStealthDepositReady(status: StealthDepositStatus): boolean {
  return status === "ready";
}

/**
 * Check if a stealth deposit is in a terminal state
 */
export function isStealthDepositTerminal(
  status: StealthDepositStatus
): boolean {
  return ["ready", "failed"].includes(status);
}

/**
 * Get human-readable status message for stealth deposit
 */
export function getStealthStatusMessage(status: StealthDepositStatus): string {
  const messages: Record<StealthDepositStatus, string> = {
    pending: "Waiting for BTC deposit",
    detected: "BTC detected in mempool",
    confirming: "Waiting for confirmation",
    confirmed: "Preparing to sweep",
    sweeping: "Sweeping to vault",
    sweep_confirming: "Sweep confirming",
    verifying: "Verifying on Solana",
    ready: "Ready! Check your Stealth Inbox",
    failed: "Deposit failed",
  };

  return messages[status] || status;
}

/**
 * Get progress percentage for a stealth deposit
 * Returns 0-100
 */
export function getStealthDepositProgress(
  status: StealthDepositStatus,
  confirmations: number,
  sweepConfirmations: number
): number {
  switch (status) {
    case "pending":
      return 5;
    case "detected":
      return 10;
    case "confirming":
      return Math.min(40, 10 + confirmations * 30);
    case "confirmed":
      return 45;
    case "sweeping":
      return 55;
    case "sweep_confirming":
      return Math.min(75, 55 + sweepConfirmations * 20);
    case "verifying":
      return 85;
    case "ready":
      return 100;
    case "failed":
      return 0;
    default:
      return 0;
  }
}
