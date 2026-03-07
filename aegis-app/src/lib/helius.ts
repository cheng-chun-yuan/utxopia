/**
 * Helius SDK Configuration
 *
 * Provides Helius RPC endpoints and priority fee estimation utilities.
 * Uses SDK's priority fee module with app-specific configuration.
 */

import {
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  estimatePriorityFee,
  getHeliusRpcUrl,
  DEFAULT_COMPUTE_UNITS,
  DEFAULT_PRIORITY_FEE,
} from "@aegis/sdk";

// Use NEXT_PUBLIC_HELIUS_RPC_URL (full URL, no API key exposed to client)
// or fall back to plain devnet. Do NOT use NEXT_PUBLIC_HELIUS_API_KEY.
const HELIUS_RPC_URL = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "";

/** Helius RPC endpoint for devnet */
export const HELIUS_RPC_DEVNET = HELIUS_RPC_URL || getHeliusRpcUrl("devnet");

/** Helius RPC endpoint for mainnet */
export const HELIUS_RPC_MAINNET = getHeliusRpcUrl("mainnet");

/**
 * Get priority fee instructions for a transaction
 *
 * Uses Helius Priority Fee API to estimate optimal priority fee based on account keys.
 * Falls back to minimal compute budget without priority fee if API unavailable.
 *
 * @param accountKeys - Array of account public key strings involved in the transaction
 * @returns Array of ComputeBudgetProgram instructions
 */
export async function getPriorityFeeInstructions(
  accountKeys: string[]
): Promise<TransactionInstruction[]> {
  const estimate = await estimatePriorityFee(accountKeys, {
    rpcEndpoint: HELIUS_RPC_URL || undefined,
    defaultComputeUnits: DEFAULT_COMPUTE_UNITS,
    defaultPriorityFee: DEFAULT_PRIORITY_FEE,
  });

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: estimate.computeUnits }),
  ];

  if (estimate.priorityFee > 0) {
    instructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: estimate.priorityFee })
    );
  }

  return instructions;
}
