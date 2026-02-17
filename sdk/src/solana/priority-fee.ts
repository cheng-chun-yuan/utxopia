/**
 * Priority Fee Estimation
 *
 * Utilities for estimating Solana transaction priority fees.
 * Supports Helius API for accurate fee estimation.
 */

// =============================================================================
// Types
// =============================================================================

export interface PriorityFeeConfig {
  /** Helius API key (optional, falls back to default fees without it) */
  heliusApiKey?: string;
  /** RPC endpoint (defaults to Helius if API key provided) */
  rpcEndpoint?: string;
  /** Default compute unit limit */
  defaultComputeUnits?: number;
  /** Default priority fee in microLamports (fallback) */
  defaultPriorityFee?: number;
}

export interface PriorityFeeEstimate {
  /** Recommended priority fee in microLamports */
  priorityFee: number;
  /** Compute unit limit to set */
  computeUnits: number;
}

export interface PriorityFeeInstructions {
  /** SetComputeUnitLimit instruction data */
  setComputeUnitLimit: {
    discriminator: number;
    units: number;
  };
  /** SetComputeUnitPrice instruction data (null if no priority fee) */
  setComputeUnitPrice: {
    discriminator: number;
    microLamports: bigint;
  } | null;
}

// =============================================================================
// Constants
// =============================================================================

/** Default compute unit limit for zVault transactions */
export const DEFAULT_COMPUTE_UNITS = 200_000;

/** Default priority fee in microLamports when estimation fails */
export const DEFAULT_PRIORITY_FEE = 1000;

/** ComputeBudgetProgram discriminators */
export const COMPUTE_BUDGET_DISCRIMINATORS = {
  SET_COMPUTE_UNIT_LIMIT: 2,
  SET_COMPUTE_UNIT_PRICE: 3,
} as const;

// =============================================================================
// Priority Fee Estimation
// =============================================================================

/**
 * Estimate priority fee using Helius API
 *
 * @param accountKeys - Array of account public key strings involved in the transaction
 * @param config - Configuration options
 * @returns Priority fee estimate
 */
export async function estimatePriorityFee(
  accountKeys: string[],
  config: PriorityFeeConfig = {}
): Promise<PriorityFeeEstimate> {
  const {
    heliusApiKey,
    rpcEndpoint,
    defaultComputeUnits = DEFAULT_COMPUTE_UNITS,
    defaultPriorityFee = DEFAULT_PRIORITY_FEE,
  } = config;

  // Determine endpoint
  const endpoint = rpcEndpoint || (heliusApiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
    : null);

  if (!endpoint) {
    // No API available, return defaults
    return {
      priorityFee: defaultPriorityFee,
      computeUnits: defaultComputeUnits,
    };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "priority-fee",
        method: "getPriorityFeeEstimate",
        params: [{
          accountKeys,
          options: { recommended: true },
        }],
      }),
    });

    const data = await response.json();
    const priorityFee = data?.result?.priorityFeeEstimate || defaultPriorityFee;

    return {
      priorityFee: Math.round(priorityFee),
      computeUnits: defaultComputeUnits,
    };
  } catch (error) {
    console.warn("Failed to get priority fee estimate:", error);
    return {
      priorityFee: defaultPriorityFee,
      computeUnits: defaultComputeUnits,
    };
  }
}

/**
 * Build priority fee instruction data
 *
 * Returns raw instruction data for ComputeBudgetProgram instructions.
 * Use this when building transactions manually.
 *
 * @param accountKeys - Array of account public key strings
 * @param config - Configuration options
 * @returns Instruction data for compute budget instructions
 */
export async function buildPriorityFeeInstructionData(
  accountKeys: string[],
  config: PriorityFeeConfig = {}
): Promise<PriorityFeeInstructions> {
  const estimate = await estimatePriorityFee(accountKeys, config);

  return {
    setComputeUnitLimit: {
      discriminator: COMPUTE_BUDGET_DISCRIMINATORS.SET_COMPUTE_UNIT_LIMIT,
      units: estimate.computeUnits,
    },
    setComputeUnitPrice: estimate.priorityFee > 0
      ? {
          discriminator: COMPUTE_BUDGET_DISCRIMINATORS.SET_COMPUTE_UNIT_PRICE,
          microLamports: BigInt(estimate.priorityFee),
        }
      : null,
  };
}

/**
 * Encode SetComputeUnitLimit instruction
 */
export function encodeSetComputeUnitLimit(units: number): Uint8Array {
  const data = new Uint8Array(5);
  data[0] = COMPUTE_BUDGET_DISCRIMINATORS.SET_COMPUTE_UNIT_LIMIT;
  // Little-endian u32
  data[1] = units & 0xff;
  data[2] = (units >> 8) & 0xff;
  data[3] = (units >> 16) & 0xff;
  data[4] = (units >> 24) & 0xff;
  return data;
}

/**
 * Encode SetComputeUnitPrice instruction
 */
export function encodeSetComputeUnitPrice(microLamports: bigint): Uint8Array {
  const data = new Uint8Array(9);
  data[0] = COMPUTE_BUDGET_DISCRIMINATORS.SET_COMPUTE_UNIT_PRICE;
  // Little-endian u64
  for (let i = 0; i < 8; i++) {
    data[1 + i] = Number((microLamports >> BigInt(i * 8)) & 0xffn);
  }
  return data;
}

/**
 * Get RPC URL with Helius API key
 *
 * @param network - "devnet" or "mainnet"
 * @param heliusApiKey - Optional Helius API key
 * @returns RPC URL
 */
export function getHeliusRpcUrl(
  network: "devnet" | "mainnet",
  heliusApiKey?: string
): string {
  if (heliusApiKey) {
    return network === "mainnet"
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
      : `https://devnet.helius-rpc.com/?api-key=${heliusApiKey}`;
  }
  return network === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com";
}
