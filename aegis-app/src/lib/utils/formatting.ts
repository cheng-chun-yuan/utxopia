// Formatting utilities

import { SATS_PER_BTC } from "@/lib/constants";

// Re-export SDK formatting utilities for bigint amounts
export { formatBtc as formatBtcBigint, parseBtc } from "@aegis/sdk";

/**
 * Format satoshis as BTC string with 8 decimal places
 */
export function formatBtc(sats: number): string {
  return (sats / SATS_PER_BTC).toFixed(8);
}

/**
 * Format a raw amount using the token's decimals, trimming trailing zeros.
 * E.g. formatAmount(50000, 8)    => "0.0005"   (BTC)
 *      formatAmount(1000000, 6)  => "1.0"      (USDC)
 *      formatAmount(15000, 8)    => "0.00015"  (BTC)
 */
export function formatAmount(raw: number, decimals: number): string {
  const full = (raw / (10 ** decimals)).toFixed(decimals);
  const trimmed = full.replace(/\.?0+$/, "");
  return trimmed.includes(".") ? trimmed : trimmed + ".0";
}

/**
 * Format satoshis with locale-aware number formatting
 */
export function formatSats(sats: number): string {
  return sats.toLocaleString();
}

/**
 * Format satoshis as "X sats (Y BTC)"
 */
export function formatSatsWithBtc(sats: number): string {
  return `${formatSats(sats)} sats (${formatBtc(sats)} BTC)`;
}

/**
 * Format USD with locale formatting
 */
export function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Truncate a string in the middle, keeping start and end characters
 */
export function truncateMiddle(str: string, visibleChars: number = 6): string {
  if (!str || str.length <= visibleChars * 2) return str;
  return `${str.slice(0, visibleChars)}...${str.slice(-visibleChars)}`;
}
