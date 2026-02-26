// Centralized application constants

// Import all addresses from SDK (single source of truth)
// No more hardcoded addresses or env var fallbacks!
import { DEVNET_CONFIG, ZVAULT_PROGRAM_ID } from "@zvault/sdk";

export { ZVAULT_PROGRAM_ID };

// Timing constants
export const POLLING_INTERVAL_MS = 30_000;
export const COPY_TIMEOUT_MS = 2_000;
export const STATS_REFRESH_MS = 60_000;

// Bitcoin constants
export const SATS_PER_BTC = 100_000_000;

// Validation limits
export const MIN_DEPOSIT_SATS = 1_000;
export const MAX_DEPOSIT_SATS = 10_000_000_000; // 100 BTC
export const MIN_WITHDRAWAL_SATS = 1_000;

// Bitcoin address regex (bech32 and legacy)
export const BTC_ADDRESS_REGEX = /^(bc1|[13]|tb1)[a-zA-HJ-NP-Z0-9]{25,62}$/;

// zVault Solana Program Configuration - ALL from SDK config (single source of truth)
export const BTC_LIGHT_CLIENT_ID = DEVNET_CONFIG.btcLightClientProgramId;
export const POOL_STATE_ADDRESS = DEVNET_CONFIG.poolStatePda;
export const COMMITMENT_TREE_ADDRESS = DEVNET_CONFIG.commitmentTreePda;
export const ZBTC_MINT_ADDRESS = DEVNET_CONFIG.zbtcMint;
export const POOL_VAULT_ADDRESS = DEVNET_CONFIG.poolVault;
export const CHADBUFFER_PROGRAM_ID = DEVNET_CONFIG.chadbufferProgramId;
