/**
 * Single source of truth for all supported tokens across the app.
 * Used by: vault page, shield flow, pay flow, activity page, explorer filters.
 *
 * ALL token metadata lives here. Components import from this file instead of
 * defining their own token arrays.
 */

export type TokenFilterId = "btc" | "sol" | "usdc" | "usdt";
export type PriceKey = "btc" | "sol" | "usdc" | "usdt";

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
  /** Display unit for amounts (e.g. "sats", "SOL", "USDC") */
  unit: string;
  /** Price API key for CoinGecko lookup */
  priceKey: PriceKey;
  /** Shielded version symbol (e.g. "zkBTC", "zkSOL") */
  shieldedSymbol: string;
  /** Shielded version logo */
  shieldedLogo: string;
  /** Explorer filter group ID */
  explorerFilter: TokenFilterId;
  /** Whether to show raw amount (true for sats) or divide by decimals */
  showRawAmount: boolean;
  /** Explorer display colors */
  explorerColors: {
    from: string; // CSS classes for "from" badge
    to: string;   // CSS classes for "to" badge
  };
  /** Explorer filter label (shown in dropdown) */
  explorerLabel: string;
  /** Explorer filter subtitle */
  explorerSubtitle: string;
  /** Secondary logo for explorer filter (e.g. zkBTC logo next to BTC) */
  explorerSecondLogo?: string;
}

/** Native wSOL mint (legacy Token program) */
export const NATIVE_WSOL_MINT = "So11111111111111111111111111111111111111112";

/** @deprecated Use NATIVE_WSOL_MINT instead */
export const NATIVE_MINT_2022_ADDRESS = NATIVE_WSOL_MINT;

/** Resolve mint addresses from network config (single source of truth) */
import { getNetworkConfig } from "./network-config";
const _netCfg = getNetworkConfig();
const ENV_USDC_MINT = _netCfg.tokens.usdcMint || process.env.NEXT_PUBLIC_USDC_MINT || "";
const ENV_USDT_MINT = _netCfg.tokens.usdtMint || process.env.NEXT_PUBLIC_USDT_MINT || "";
const ENV_WSOL_MINT = _netCfg.tokens.wsolMint || process.env.NEXT_PUBLIC_WSOL_MINT || "";
const ENV_JUPUSD_MINT = (_netCfg.tokens as any).jupusdMint || process.env.NEXT_PUBLIC_JUPUSD_MINT || "";

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
    unit: "BTC",
    priceKey: "btc",
    shieldedSymbol: "zkBTC",
    shieldedLogo: "/tokens/zkbtc.png",
    explorerFilter: "btc",
    showRawAmount: false,
    explorerColors: {
      from: "text-btc/70 bg-btc/6 border-btc/10",
      to: "text-privacy/80 bg-privacy/6 border-privacy/10",
    },
    explorerLabel: "BTC / zkBTC",
    explorerSubtitle: "Shielded Bitcoin",
    explorerSecondLogo: "/tokens/zkbtc.png",
  },
  {
    symbol: "zkBTC",
    name: "Shielded Bitcoin",
    decimals: 8,
    logo: "/tokens/zkbtc.png",
    mint: "",
    isBtcNative: false,
    isSOL: false,
    enabled: true,
    unit: "BTC",
    priceKey: "btc",
    shieldedSymbol: "zkBTC",
    shieldedLogo: "/tokens/zkbtc.png",
    explorerFilter: "btc",
    showRawAmount: false,
    explorerColors: {
      from: "text-btc/70 bg-btc/6 border-btc/10",
      to: "text-privacy/80 bg-privacy/6 border-privacy/10",
    },
    explorerLabel: "BTC / zkBTC",
    explorerSubtitle: "Shielded Bitcoin",
    explorerSecondLogo: "/tokens/zkbtc.png",
  },
  {
    symbol: "SOL",
    name: "Solana",
    decimals: 9,
    logo: "/tokens/sol.png",
    mint: ENV_WSOL_MINT || NATIVE_WSOL_MINT,
    isBtcNative: false,
    isSOL: true,
    enabled: true,
    unit: "SOL",
    priceKey: "sol",
    shieldedSymbol: "zkSOL",
    shieldedLogo: "/tokens/sol.png",
    explorerFilter: "sol",
    showRawAmount: false,
    explorerColors: {
      from: "text-sol/70 bg-sol/6 border-sol/10",
      to: "text-privacy/80 bg-privacy/6 border-privacy/10",
    },
    explorerLabel: "SOL",
    explorerSubtitle: "Solana",
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logo: "/tokens/usdc.png",
    mint: ENV_USDC_MINT,
    isBtcNative: false,
    isSOL: false,
    enabled: true,
    unit: "USDC",
    priceKey: "usdc",
    shieldedSymbol: "zkUSDC",
    shieldedLogo: "/tokens/usdc.png",
    explorerFilter: "usdc",
    showRawAmount: false,
    explorerColors: {
      from: "text-green-400/70 bg-green-500/6 border-green-500/10",
      to: "text-privacy/80 bg-privacy/6 border-privacy/10",
    },
    explorerLabel: "USDC",
    explorerSubtitle: "SPL Token",
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    logo: "/tokens/usdt.png",
    mint: ENV_USDT_MINT,
    isBtcNative: false,
    isSOL: false,
    enabled: true,
    unit: "USDT",
    priceKey: "usdt",
    shieldedSymbol: "zkUSDT",
    shieldedLogo: "/tokens/usdt.png",
    explorerFilter: "usdt",
    showRawAmount: false,
    explorerColors: {
      from: "text-green-400/70 bg-green-500/6 border-green-500/10",
      to: "text-privacy/80 bg-privacy/6 border-privacy/10",
    },
    explorerLabel: "USDT",
    explorerSubtitle: "SPL Token",
  },
  {
    symbol: "jupUSD",
    name: "Jupiter USD",
    decimals: 9,
    logo: "/tokens/jupusd.png",
    mint: ENV_JUPUSD_MINT,
    isBtcNative: false,
    isSOL: false,
    enabled: true,
    unit: "jupUSD",
    priceKey: "usdc",
    shieldedSymbol: "zkJupUSD",
    shieldedLogo: "/tokens/jupusd.png",
    explorerFilter: "usdc",
    showRawAmount: false,
    explorerColors: {
      from: "text-green-400/70 bg-green-500/6 border-green-500/10",
      to: "text-privacy/80 bg-privacy/6 border-privacy/10",
    },
    explorerLabel: "jupUSD",
    explorerSubtitle: "Jupiter Stablecoin",
  },
];

/** Only enabled tokens */
export const ENABLED_TOKENS = SUPPORTED_TOKENS.filter((t) => t.enabled);

/** Tokens for the shield flow (includes BTC native) */
export const SHIELD_TOKENS = SUPPORTED_TOKENS.filter((t) => t.enabled);

/** Tokens for the vault balance display (excludes BTC native, uses shielded symbols) */
export const VAULT_TOKENS = SUPPORTED_TOKENS.filter((t) => t.enabled && !t.isBtcNative);

/** Tokens for the pay/send flow (excludes BTC native) */
export const PAY_TOKENS = SUPPORTED_TOKENS.filter((t) => t.enabled && !t.isBtcNative);

/** Explorer filter tokens (one per filter group, deduplicated) */
export const EXPLORER_FILTER_TOKENS = SUPPORTED_TOKENS.filter(
  (t, i, arr) => t.enabled && arr.findIndex((x) => x.explorerFilter === t.explorerFilter) === i
);

/** Look up token config by explorer filter ID */
export function getTokenByFilter(filterId: TokenFilterId): SupportedToken | undefined {
  return EXPLORER_FILTER_TOKENS.find((t) => t.explorerFilter === filterId);
}

/** Look up token config by symbol */
export function getTokenBySymbol(symbol: string): SupportedToken | undefined {
  return SUPPORTED_TOKENS.find((t) => t.symbol === symbol);
}

/**
 * Format an amount using the token's decimals and unit.
 * @param rawAmount - Amount in smallest units (sats, lamports, micro-units)
 * @param token - Token config (or just decimals + unit + showRawAmount)
 */
export function formatTokenAmount(
  rawAmount: number,
  token: Pick<SupportedToken, "decimals" | "unit" | "showRawAmount">,
): string {
  if (token.showRawAmount) {
    return `${rawAmount.toLocaleString()} ${token.unit}`;
  }
  const value = rawAmount / (10 ** token.decimals);
  return `${value.toLocaleString(undefined, { maximumFractionDigits: token.decimals })} ${token.unit}`;
}
