/**
 * Shared API configuration
 */

export const API_BASE =
  process.env.EXPO_PUBLIC_API_URL || "https://api-aegis.amidoggy.xyz";

/** Convert HTTP URL to WebSocket URL */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^https/, "wss").replace(/^http/, "ws");
}

export const WS_BASE = toWsUrl(API_BASE);

/** Standard JSON fetcher for SWR */
export const fetcher = (url: string) => fetch(url).then((r) => r.json());
