// Formatting utilities

import { SATS_PER_BTC } from "@/lib/constants";

// Re-export SDK formatting utilities for bigint amounts
export { formatBtc as formatBtcBigint, parseBtc } from "@utxopia/sdk";

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
 * Truncate a string in the middle with asymmetric start/end lengths.
 * Used throughout explorer for tx signatures, addresses, commitments.
 */
export function truncate(str: string, start = 6, end = 4): string {
  if (!str || str.length <= start + end + 3) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}

/**
 * Truncate a string symmetrically (same chars from each side).
 * Convenience wrapper around truncate.
 */
export function truncateMiddle(str: string, visibleChars: number = 6): string {
  return truncate(str, visibleChars, visibleChars);
}

/**
 * Format a unix timestamp into a human-readable relative time string.
 */
export function timeAgo(timestamp: number): string {
  if (timestamp === 0) return "—";
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}
