/**
 * GET /api/relayer/meta — Proxy to backend /api/relayer/meta
 *
 * Returns relayer and service fee configuration from the backend.
 */

import { proxyToBackend } from "@/lib/api/backend-proxy";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return proxyToBackend(request, "/api/relayer/meta");
}
