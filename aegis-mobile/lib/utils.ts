import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names with tailwind-merge support.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Format satoshis as a BTC string (e.g. 150000 → "0.00150000").
 */
export function formatSats(sats: number): string {
  const btc = sats / 1e8;
  return btc.toFixed(8);
}

/**
 * Format a BTC value with proper decimals (e.g. 0.0015 → "0.00150000").
 */
export function formatBtc(btc: number): string {
  return btc.toFixed(8);
}

/**
 * Truncate an address with ellipsis (e.g. "tb1q...abc123").
 */
export function truncateAddress(addr: string, chars: number = 6): string {
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}
