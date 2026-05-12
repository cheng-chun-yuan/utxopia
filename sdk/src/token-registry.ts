/**
 * Token Registry — fetch and manage supported tokens in the multi-token shielded pool.
 *
 * Each whitelisted token has a TokenConfig PDA on-chain storing:
 * mint, token_id, vault, decimals, service_fee, min/max deposit, deposit_cap, etc.
 *
 * @module token-registry
 */

import { type Address } from "@solana/kit";
import { computeTokenId } from "./poseidon";
import { deriveTokenConfigPDA } from "./pda";
import { address, getConfig } from "./config";

// ============================================================================
// Types
// ============================================================================

/** On-chain TokenConfig account data (parsed) */
export interface TokenConfigData {
  /** SPL mint address */
  mint: Address;
  /** Poseidon(reduce_to_field(mint), 0) */
  tokenId: bigint;
  /** Token vault address (PDA-owned) */
  vault: Address;
  /** Token decimals */
  decimals: number;
  /** Whether the token is enabled for shielding */
  enabled: boolean;
  /** Flat service fee per BTC operation (native units) */
  serviceFee: bigint;
  /** Minimum deposit amount */
  minDeposit: bigint;
  /** Maximum deposit amount */
  maxDeposit: bigint;
  /** Maximum total shielded for this token */
  depositCap: bigint;
  /** Current total shielded */
  totalShielded: bigint;
  /** Accumulated protocol fees */
  accumulatedFees: bigint;
  /** TokenConfig PDA address */
  configAddress: Address;
}

/** Minimal token info for selection UI */
export interface SupportedToken {
  /** Display name (from metadata or derived) */
  name: string;
  /** Token symbol */
  symbol: string;
  /** SPL mint address */
  mint: Address;
  /** Token decimals */
  decimals: number;
  /** Whether enabled */
  enabled: boolean;
  /** Computed token_id for circuit use */
  tokenId: bigint;
  /** TokenConfig PDA address */
  configAddress: Address;
}

// ============================================================================
// TokenConfig PDA Layout (must match on-chain token_config.rs)
// ============================================================================

const TOKEN_CONFIG_DISCRIMINATOR = 0x0b;
const TOKEN_CONFIG_LEN = 164;

/** Parse TokenConfig from raw account data */
export function parseTokenConfig(data: Uint8Array, configAddress: Address): TokenConfigData | null {
  if (data.length < TOKEN_CONFIG_LEN) return null;
  if (data[0] !== TOKEN_CONFIG_DISCRIMINATOR) return null;

  // Layout (from token_config.rs):
  // disc(1) + bump(1) + mint(32) + token_id(32) + vault(32) + decimals(1) + enabled(1)
  // + service_fee(8) + min_deposit(8) + max_deposit(8) + deposit_cap(8) + total_shielded(8) + accumulated_fees(8) + reserved(16)

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const mintBytes = data.slice(2, 34);
  const tokenIdBytes = data.slice(34, 66);
  const vaultBytes = data.slice(66, 98);
  const decimals = data[98];
  const enabled = data[99] !== 0;

  const serviceFee = view.getBigUint64(100, true);
  const minDeposit = view.getBigUint64(108, true);
  const maxDeposit = view.getBigUint64(116, true);
  const depositCap = view.getBigUint64(124, true);
  const totalShielded = view.getBigUint64(132, true);
  const accumulatedFees = view.getBigUint64(140, true);

  // Convert bytes to bigint for tokenId (big-endian)
  let tokenId = 0n;
  for (const b of tokenIdBytes) {
    tokenId = (tokenId << 8n) | BigInt(b);
  }

  return {
    mint: address(Buffer.from(mintBytes).toString("base64")),  // This needs proper base58
    tokenId,
    vault: address(Buffer.from(vaultBytes).toString("base64")),
    decimals,
    enabled,
    serviceFee,
    minDeposit,
    maxDeposit,
    depositCap,
    totalShielded,
    accumulatedFees,
    configAddress,
  };
}

// ============================================================================
// Token Selection & Fetching
// ============================================================================

/**
 * Get TokenConfig for a specific mint.
 * Derives the PDA and fetches from chain.
 *
 * @param rpc - Solana RPC client (must have getAccountInfo)
 * @param mintAddress - SPL mint address (raw 32-byte pubkey)
 */
export async function getTokenConfig(
  rpc: { getAccountInfo(addr: Address, opts?: object): Promise<{ value: { data: Uint8Array } | null }> },
  mintAddress: Uint8Array,
): Promise<TokenConfigData | null> {
  const config = getConfig();
  const [configPda] = await deriveTokenConfigPDA(mintAddress, config.utxopiaProgramId);

  const accountInfo = await rpc.getAccountInfo(configPda, { encoding: "base64" });
  if (!accountInfo?.value?.data) return null;

  const data = accountInfo.value.data instanceof Uint8Array
    ? accountInfo.value.data
    : new Uint8Array(Buffer.from(accountInfo.value.data as unknown as string, "base64"));

  return parseTokenConfig(data, configPda);
}

/**
 * Compute token_id for a mint address (for use in circuit inputs).
 * This is a pure computation — no RPC call needed.
 *
 * @param mintPubkey - 32-byte mint public key
 * @returns tokenId as bigint
 */
export function getTokenId(mintPubkey: Uint8Array): bigint {
  return computeTokenId(mintPubkey);
}

/**
 * Fetch all supported tokens by scanning TokenConfig PDAs.
 *
 * Uses getProgramAccounts with memcmp filter on the discriminator byte.
 *
 * @param rpc - Solana RPC client
 */
export async function fetchSupportedTokens(
  rpc: {
    getProgramAccounts(
      programId: Address,
      opts?: object,
    ): Promise<{ pubkey: Address; account: { data: Uint8Array } }[]>;
  },
): Promise<TokenConfigData[]> {
  const config = getConfig();

  const accounts = await rpc.getProgramAccounts(config.utxopiaProgramId, {
    filters: [
      { dataSize: TOKEN_CONFIG_LEN },
      { memcmp: { offset: 0, bytes: Buffer.from([TOKEN_CONFIG_DISCRIMINATOR]).toString("base64") } },
    ],
    encoding: "base64",
  });

  const tokens: TokenConfigData[] = [];
  for (const { pubkey, account } of accounts) {
    const data = account.data instanceof Uint8Array
      ? account.data
      : new Uint8Array(Buffer.from(account.data as unknown as string, "base64"));

    const parsed = parseTokenConfig(data, pubkey);
    if (parsed) tokens.push(parsed);
  }

  return tokens;
}

/**
 * Fetch only enabled tokens (convenience wrapper).
 */
export async function fetchEnabledTokens(
  rpc: Parameters<typeof fetchSupportedTokens>[0],
): Promise<TokenConfigData[]> {
  const all = await fetchSupportedTokens(rpc);
  return all.filter((t) => t.enabled);
}
