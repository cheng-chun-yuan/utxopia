/**
 * API Client - Minimal Backend Interface
 *
 * Architecture:
 * - Most operations (deposit, claim, split) are handled client-side via SDK + Solana
 * - Only redemption (BTC withdrawal) requires backend (server-side BTC signing)
 * - Block header submission uses Next.js API routes (proxied to relayer)
 * - Deposit status checked via mempool.space directly (no backend needed)
 *
 * Backend provides:
 * 1. POST /api/redeem - Process BTC withdrawal request
 * 2. GET /api/withdrawal/:id - Check withdrawal status
 */

import type {
  RedeemRequest,
  RedeemResponse,
  WithdrawalStatusResponse,
  DepositStatusResponse,
  SubmitHeaderRequest,
  SubmitHeaderResponse,
  HeaderStatusResponse,
} from "./types";
import { ApiError } from "./errors";
import { API_ENDPOINTS, DEFAULT_API_URL } from "./constants";

/**
 * zVault API Client (Minimal - Redemption Only)
 *
 * Note: Deposit and claim operations are handled client-side:
 * - Use @/lib/sdk for deposit credential generation
 * - Use @/lib/solana/instructions for Solana transactions
 * - Use getDepositStatusFromMempool() for deposit status
 */
class zBTCApiClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.NEXT_PUBLIC_ZKBTC_API_URL || DEFAULT_API_URL;
  }

  private async request<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<T> {
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        headers: {
          "Content-Type": "application/json",
          ...options?.headers,
        },
        ...options,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({
          error: `HTTP ${response.status}: ${response.statusText}`,
        }));
        throw ApiError.fromResponse(error, response.status);
      }

      return await response.json();
    } catch (error) {
      throw ApiError.fromUnknown(error);
    }
  }

  // ============ Redemption (Backend Required) ============

  /**
   * Redeem zBTC tokens for BTC withdrawal
   *
   * This is the main backend operation - BTC signing must happen server-side.
   * The backend redemption processor will:
   * 1. Verify the burn transaction on Solana
   * 2. Build and sign the BTC withdrawal transaction
   * 3. Broadcast to Bitcoin network
   *
   * @param amountSats - Amount to redeem in satoshis
   * @param btcAddress - Bitcoin address for withdrawal
   * @param solanaAddress - Solana address that burned the zBTC
   */
  async redeem(
    amountSats: number,
    btcAddress: string,
    solanaAddress: string
  ): Promise<RedeemResponse> {
    const body: RedeemRequest = {
      amount_sats: amountSats,
      btc_address: btcAddress,
      solana_address: solanaAddress,
    };

    return this.request<RedeemResponse>(API_ENDPOINTS.REDEEM, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Get the status of a withdrawal request
   *
   * @param requestId - Withdrawal request ID from redeem() response
   */
  async getWithdrawalStatus(requestId: string): Promise<WithdrawalStatusResponse> {
    return this.request<WithdrawalStatusResponse>(API_ENDPOINTS.WITHDRAWAL_STATUS(requestId));
  }

  // ============ Block Header Management (Next.js API Routes) ============

  /**
   * Submit a Bitcoin block header to be published on-chain by the relayer
   * Uses internal Next.js API route (proxied to header-relayer service)
   */
  async submitHeader(
    blockHeight: number,
    blockHash: string,
    rawHeader: string,
    prevBlockHash: string,
    merkleRoot: string,
    timestamp: number,
    bits: number,
    nonce: number
  ): Promise<SubmitHeaderResponse> {
    const body: SubmitHeaderRequest = {
      block_height: blockHeight,
      block_hash: blockHash,
      raw_header: rawHeader,
      prev_block_hash: prevBlockHash,
      merkle_root: merkleRoot,
      timestamp,
      bits,
      nonce,
    };

    // Use internal API route (same origin)
    const response = await fetch("/api/header/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
   * Check if a block header exists on-chain
   * Uses internal Next.js API route
   */
  async getHeaderStatus(blockHeight: number): Promise<HeaderStatusResponse> {
    const response = await fetch(`/api/header/status/${blockHeight}`);

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        error: `HTTP ${response.status}: ${response.statusText}`,
      }));
      throw ApiError.fromResponse(error, response.status);
    }

    return response.json();
  }
}

// Export singleton instance
export const zBTCApi = new zBTCApiClient();

// Export class for custom instances
export { zBTCApiClient };

// ============ Mempool.space Direct API (No Backend Needed) ============

const MEMPOOL_API_TESTNET = "https://mempool.space/testnet/api";
const REQUIRED_CONFIRMATIONS = 2;

interface MempoolAddressInfo {
  address: string;
  chain_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
  mempool_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
}

interface MempoolTransaction {
  txid: string;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_time?: number;
  };
  vout: Array<{
    scriptpubkey_address?: string;
    value: number;
  }>;
}

/**
 * Fetch deposit status directly from mempool.space by taproot address
 *
 * This function queries Bitcoin network directly - no backend needed.
 * Uses mempool.space API for testnet.
 *
 * @param taprootAddress - Bitcoin taproot address (tb1p...)
 * @returns Deposit status with confirmation count
 */
export async function getDepositStatusFromMempool(
  taprootAddress: string
): Promise<DepositStatusResponse> {
  try {
    // Get address info
    const addressRes = await fetch(`${MEMPOOL_API_TESTNET}/address/${taprootAddress}`);
    if (!addressRes.ok) {
      return {
        found: false,
        confirmations: 0,
        required_confirmations: REQUIRED_CONFIRMATIONS,
        status: "waiting_payment",
        escrow_status: "waiting_payment",
        can_claim: false,
        claimed: false,
        refund_available: false,
      };
    }

    const addressInfo: MempoolAddressInfo = await addressRes.json();

    // Check if any transactions received
    const totalReceived = addressInfo.chain_stats.funded_txo_sum + addressInfo.mempool_stats.funded_txo_sum;

    if (totalReceived === 0) {
      return {
        found: false,
        taproot_address: taprootAddress,
        confirmations: 0,
        required_confirmations: REQUIRED_CONFIRMATIONS,
        status: "waiting_payment",
        escrow_status: "waiting_payment",
        can_claim: false,
        claimed: false,
        refund_available: false,
      };
    }

    // Get transactions to find the deposit
    const txsRes = await fetch(`${MEMPOOL_API_TESTNET}/address/${taprootAddress}/txs`);
    const txs: MempoolTransaction[] = txsRes.ok ? await txsRes.json() : [];

    // Find the deposit transaction (first incoming tx to this address)
    let depositTx: MempoolTransaction | null = null;
    let depositAmount = 0;

    for (const tx of txs) {
      for (const vout of tx.vout) {
        if (vout.scriptpubkey_address === taprootAddress) {
          depositTx = tx;
          depositAmount = vout.value;
          break;
        }
      }
      if (depositTx) break;
    }

    if (!depositTx) {
      return {
        found: false,
        taproot_address: taprootAddress,
        confirmations: 0,
        required_confirmations: REQUIRED_CONFIRMATIONS,
        status: "waiting_payment",
        escrow_status: "waiting_payment",
        can_claim: false,
        claimed: false,
        refund_available: false,
      };
    }

    // Calculate confirmations
    let confirmations = 0;
    if (depositTx.status.confirmed && depositTx.status.block_height) {
      // Get current block height
      const tipRes = await fetch(`${MEMPOOL_API_TESTNET}/blocks/tip/height`);
      if (tipRes.ok) {
        const tipHeight = parseInt(await tipRes.text(), 10);
        confirmations = tipHeight - depositTx.status.block_height + 1;
      }
    }

    const canClaim = confirmations >= REQUIRED_CONFIRMATIONS;

    // Determine escrow status
    let escrowStatus: DepositStatusResponse["escrow_status"] = "waiting_payment";
    if (depositTx.status.confirmed) {
      if (confirmations >= REQUIRED_CONFIRMATIONS) {
        escrowStatus = "passed"; // Ready to claim
      } else {
        escrowStatus = "confirming";
      }
    } else {
      escrowStatus = "confirming"; // In mempool
    }

    return {
      found: true,
      taproot_address: taprootAddress,
      amount_sats: depositAmount,
      btc_txid: depositTx.txid,
      confirmations,
      required_confirmations: REQUIRED_CONFIRMATIONS,
      status: escrowStatus,
      escrow_status: escrowStatus,
      can_claim: canClaim,
      claimed: false,
      refund_available: false,
    };
  } catch (error) {
    console.error("Failed to fetch from mempool.space:", error);
    return {
      found: false,
      confirmations: 0,
      required_confirmations: REQUIRED_CONFIRMATIONS,
      status: "waiting_payment",
      escrow_status: "waiting_payment",
      can_claim: false,
      claimed: false,
      refund_available: false,
    };
  }
}
