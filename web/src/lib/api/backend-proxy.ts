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

  let res: Response;
  try {
    res = await fetch(target, {
      method: request.method,
      headers,
      body,
    });
  } catch (err) {
    // Backend unreachable (DNS/TLS/connect failure). Surface as 502 with a
    // structured body so callers can tell this apart from an app-code 500.
    const message = err instanceof Error ? err.message : String(err);
    let host: string | null = null;
    try {
      host = new URL(backendUrl).host;
    } catch {
      // ignore
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: "Backend unreachable",
        code: "BACKEND_UNREACHABLE",
        network,
        backendHost: host,
        message,
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return new Response(await res.text(), {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/json",
    },
  });
}
