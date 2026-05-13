/**
 * Diagnostic endpoint — echoes back the server's view of the request:
 *   - cookie header (raw)
 *   - parsed network
 *   - resolved backend URL
 *   - relevant env vars
 *
 * Hit with /api/_debug from the browser to confirm the cookie reaches the
 * server and the network resolution does what we expect. Server-side only,
 * no secrets exposed.
 */

import { NextResponse } from "next/server";
import {
  detectNetwork,
  detectNetworkFromRequest,
  parseNetworkCookie,
} from "@/lib/network-config";
import { getBackendUrl } from "@/lib/api/constants";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cookieHeader = request.headers.get("cookie");
  const parsed = parseNetworkCookie(cookieHeader);
  const fromRequest = detectNetworkFromRequest(request);
  const fromEnv = detectNetwork();
  const backendUrl = getBackendUrl(fromRequest);
  const knownNetworks = Object.keys(
    (await import("@/lib/networks.json")).default,
  );

  // Probe the resolved backend so we can see if it's reachable.
  let probeStatus: number | string;
  let probeBody: string;
  try {
    const r = await fetch(`${backendUrl}/api/tree/status`, {
      cache: "no-store",
    });
    probeStatus = r.status;
    probeBody = (await r.text()).slice(0, 200);
  } catch (e) {
    probeStatus = "FETCH_THREW";
    probeBody = (e as Error).message;
  }

  return NextResponse.json({
    cookieHeader: cookieHeader ?? null,
    parsedFromCookie: parsed,
    detectNetworkFromRequest: fromRequest,
    detectNetwork_envFallback: fromEnv,
    resolvedBackendUrl: backendUrl,
    knownNetworksInDeployedJson: knownNetworks,
    envVars: {
      NEXT_PUBLIC_NETWORK: process.env.NEXT_PUBLIC_NETWORK ?? null,
      UTXOPIA_NETWORK: process.env.UTXOPIA_NETWORK ?? null,
      BACKEND_API_URL_set: !!process.env.BACKEND_API_URL,
      BACKEND_URL_set: !!process.env.BACKEND_URL,
      NEXT_PUBLIC_BACKEND_API_URL_set: !!process.env.NEXT_PUBLIC_BACKEND_API_URL,
      // Don't echo the full URL in case it's a token-bearing endpoint.
      // Just show the host.
      BACKEND_API_URL_host: (() => {
        try {
          return new URL(process.env.BACKEND_API_URL ?? "").host;
        } catch {
          return null;
        }
      })(),
    },
    probe: {
      url: `${backendUrl}/api/tree/status`,
      status: probeStatus,
      body: probeBody,
    },
  });
}
