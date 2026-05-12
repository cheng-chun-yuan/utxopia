/**
 * Server-side proxy helper for forwarding requests to the backend.
 *
 * Used by Next.js API routes to proxy client requests to the Rust backend,
 * avoiding CORS/PNA issues (browser never talks to backend directly).
 *
 * The backend URL is resolved per-request from the `utxopia.network` cookie,
 * so a user who flips network in /settings has subsequent /api/* requests
 * routed to the matching stack (production devnet vs hybrid devnet-regtest).
 */

import { getBackendUrl } from "@/lib/api/constants";
import { detectNetworkFromRequest } from "@/lib/network-config";

const BACKEND_API_KEY =
  process.env.BACKEND_API_KEY || "";

export async function proxyToBackend(
  request: Request,
  backendPath: string,
): Promise<Response> {
  const url = new URL(request.url);
  const network = detectNetworkFromRequest(request);
  const backendUrl = getBackendUrl(network);
  const target = `${backendUrl}${backendPath}${url.search}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (BACKEND_API_KEY) {
    headers["X-API-Key"] = BACKEND_API_KEY;
  }

  const body =
    request.method !== "GET" && request.method !== "HEAD"
      ? await request.text()
      : undefined;

  const res = await fetch(target, {
    method: request.method,
    headers,
    body,
  });

  return new Response(await res.text(), {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/json",
    },
  });
}
