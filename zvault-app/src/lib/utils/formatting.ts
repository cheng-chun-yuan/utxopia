// Formatting utilities

import { SATS_PER_BTC } from "@/lib/constants";

// Re-export SDK formatting utilities for bigint amounts
export { formatBtc as formatBtcBigint, parseBtc } from "@zvault/sdk";

/**
 * Format satoshis as BTC string with 8 decimal places
 */
export function formatBtc(sats: number): string {
  return (sats / SATS_PER_BTC).toFixed(8);
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
