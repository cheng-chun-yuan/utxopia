/**
 * Server-side Helius Configuration
 *
 * Provides both @solana/kit Rpc and @solana/web3.js Connection for API routes.
 * Uses server-side API key (not exposed to client).
 *
 * Use getRpc() for pure reads (modern, efficient).
 * Use getHeliusConnection() for transaction signing (legacy compatibility).
 */

import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { Connection } from "@solana/web3.js";

// Server-side Helius API key (more secure than client-side)
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || process.env.NEXT_PUBLIC_HELIUS_API_KEY || "";

// =============================================================================
// RPC URL Configuration
// =============================================================================

/** Get Helius RPC URL for the current network */
export function getHeliusRpcUrl(network: "devnet" | "mainnet" = "devnet"): string {
  if (HELIUS_API_KEY) {
    return network === "mainnet"
      ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
      : `https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  }

  // Fallback to public RPC
  return network === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
}

/** Check if Helius is configured */
export function isHeliusConfigured(): boolean {
  return !!HELIUS_API_KEY;
}

// =============================================================================
// @solana/kit Rpc (Modern - for pure reads)
// =============================================================================

/** Cached @solana/kit Rpc instances per network */
const rpcCache: Record<string, Rpc<SolanaRpcApi>> = {};

/**
 * Get a cached @solana/kit Rpc instance.
 * Use this for pure RPC reads in API routes.
 */
export function getRpc(network: "devnet" | "mainnet" = "devnet"): Rpc<SolanaRpcApi> {
  if (!rpcCache[network]) {
    rpcCache[network] = createSolanaRpc(getHeliusRpcUrl(network));
  }
  return rpcCache[network];
}

/**
 * Fetch account info using @solana/kit.
 * Returns null if account doesn't exist.
 */
export async function fetchAccountInfo(
  address: string,
  network: "devnet" | "mainnet" = "devnet"
): Promise<{ data: Uint8Array; lamports: bigint } | null> {
  const rpc = getRpc(network);
  const result = await rpc.getAccountInfo(address as Parameters<typeof rpc.getAccountInfo>[0], {
    encoding: "base64",
  }).send();

  if (!result.value) {
    return null;
  }

  // Decode base64 data
  const data = typeof result.value.data === "string"
    ? Uint8Array.from(atob(result.value.data), c => c.charCodeAt(0))
    : result.value.data[0]
      ? Uint8Array.from(atob(result.value.data[0]), c => c.charCodeAt(0))
      : new Uint8Array();

  return {
    data,
    lamports: result.value.lamports,
  };
}

// =============================================================================
// @solana/web3.js Connection (Legacy - for transaction signing)
// =============================================================================

/** Cached @solana/web3.js Connection instances per network */
const connectionCache: Record<string, Connection> = {};

/**
 * Get a cached Solana connection using Helius RPC.
 * Use this for transaction signing operations.
 */
export function getHeliusConnection(network: "devnet" | "mainnet" = "devnet"): Connection {
  if (!connectionCache[network]) {
    connectionCache[network] = new Connection(getHeliusRpcUrl(network), {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60000,
    });
  }
  return connectionCache[network];
}

// =============================================================================
// Priority Fee Estimation
// =============================================================================

/**
 * Get priority fee estimate from Helius
 */
export async function getHeliusPriorityFee(
  accountKeys: string[],
  network: "devnet" | "mainnet" = "devnet"
): Promise<number> {
  if (!HELIUS_API_KEY) {
    return 1000; // Default 1000 microLamports
  }

  try {
    const rpcUrl = getHeliusRpcUrl(network);
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "priority-fee",
        method: "getPriorityFeeEstimate",
        params: [
          {
            accountKeys,
            options: { recommended: true },
          },
        ],
      }),
    });

    const data = await response.json();
    return data?.result?.priorityFeeEstimate || 1000;
  } catch (error) {
    console.warn("[Helius] Failed to get priority fee:", error);
    return 1000;
  }
}
