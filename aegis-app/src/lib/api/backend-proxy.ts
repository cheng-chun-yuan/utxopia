/**
 * Server-side proxy helper for forwarding requests to the backend.
 *
 * Used by Next.js API routes to proxy client requests to the Rust backend,
 * avoiding CORS/PNA issues (browser never talks to backend directly).
 */

import { getBackendUrl } from "@/lib/api/constants";

const BACKEND_URL = getBackendUrl();
const BACKEND_API_KEY =
  process.env.BACKEND_API_KEY || "";

export async function proxyToBackend(
  request: Request,
  backendPath: string,
): Promise<Response> {
  const url = new URL(request.url);
  const target = `${BACKEND_URL}${backendPath}${url.search}`;

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
