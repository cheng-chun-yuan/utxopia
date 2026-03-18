/**
 * Single source of truth for all supported tokens across the app.
 * Used by: vault page, shield flow, pay flow, activity page, explorer filters.
 */

export interface SupportedToken {
  symbol: string;
  name: string;
  decimals: number;
  logo: string;
  /** Mint address (empty string = resolved at runtime from SDK config) */
  mint: string;
  /** True for BTC (uses Taproot deposit flow, not SPL shield) */
  isBtcNative: boolean;
  /** True for SOL (wraps to wSOL via NATIVE_MINT_2022 before shield) */
  isSOL: boolean;
  /** Whether this token is live (vs coming soon) */
  enabled: boolean;
  /** Display unit for amounts */
  unit: string;
}

/** NATIVE_MINT_2022 — Token-2022 wrapped SOL mint */
export const NATIVE_MINT_2022_ADDRESS = "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP";

export const SUPPORTED_TOKENS: SupportedToken[] = [
  {
    symbol: "BTC",
    name: "Bitcoin",
    decimals: 8,
    logo: "/tokens/btc.png",
    mint: "",
    isBtcNative: true,
    isSOL: false,
    enabled: true,
    unit: "sats",
  },
  {
    symbol: "zkBTC",
    name: "Shielded Bitcoin",
    decimals: 8,
    logo: "/zkbtc.png",
    mint: "",
    isBtcNative: false,
    isSOL: false,
    enabled: true,
    unit: "sats",
  },
  {
    symbol: "SOL",
    name: "Solana",
    decimals: 9,
    logo: "/tokens/sol.png",
    mint: NATIVE_MINT_2022_ADDRESS,
    isBtcNative: false,
    isSOL: true,
    enabled: true,
    unit: "SOL",
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logo: "/tokens/usdc.png",
    mint: "",
    isBtcNative: false,
    isSOL: false,
    enabled: true,
    unit: "USDC",
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    logo: "/tokens/usdt.png",
    mint: "",
    isBtcNative: false,
    isSOL: false,
    enabled: true,
    unit: "USDT",
  },
];

/** Only enabled tokens */
export const ENABLED_TOKENS = SUPPORTED_TOKENS.filter((t) => t.enabled);

/** Tokens for the shield flow (includes BTC native) */
export const SHIELD_TOKENS = SUPPORTED_TOKENS.filter((t) => t.enabled);

/** Tokens for the vault balance display (excludes BTC native) */
export const VAULT_TOKENS = SUPPORTED_TOKENS.filter((t) => t.enabled && !t.isBtcNative);

/** Tokens for the pay/send flow (excludes BTC native) */
export const PAY_TOKENS = SUPPORTED_TOKENS.filter((t) => t.enabled && !t.isBtcNative);
