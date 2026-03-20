/**
 * Authenticated fetch wrapper for relay endpoints.
 * Adds the RELAY_API_KEY header to relay/unshield/redeem/demo requests.
 *
 * The key is a public env var (NEXT_PUBLIC_RELAY_API_KEY) that the frontend
 * sends to the Next.js API routes. This is NOT a secret — it prevents
 * external abuse while allowing the app's own frontend to call relay endpoints.
 *
 * For true security, relay endpoints should be moved to the Rust backend
 * and called via the backend proxy with server-side BACKEND_API_KEY.
 */

const RELAY_API_KEY = process.env.NEXT_PUBLIC_RELAY_API_KEY || "";

export async function relayFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (RELAY_API_KEY) {
    headers.set("X-API-Key", RELAY_API_KEY);
  }
  return fetch(url, { ...options, headers });
}
