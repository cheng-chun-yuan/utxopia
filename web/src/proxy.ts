import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Allowed origins for API requests (env var is comma-separated) */
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || process.env.NEXT_PUBLIC_BASE_URL || ""
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true; // Same-origin requests have no Origin header
  if (ALLOWED_ORIGINS.length === 0) {
    if (process.env.NODE_ENV === "production") return false;
    return true;
  }
  return ALLOWED_ORIGINS.some(
    (allowed) => origin === allowed || origin === allowed.replace(/\/$/, "")
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const origin = request.headers.get("origin");

  if (pathname.startsWith("/api/")) {
    if (!isAllowedOrigin(origin)) {
      return NextResponse.json(
        { success: false, error: "Forbidden: origin not allowed" },
        { status: 403 }
      );
    }

    if (request.method === "OPTIONS") {
      const res = new NextResponse(null, { status: 204 });
      if (origin && isAllowedOrigin(origin)) {
        res.headers.set("Access-Control-Allow-Origin", origin);
        res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.headers.set("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
        res.headers.set("Access-Control-Max-Age", "86400");
      }
      return res;
    }

    const response = NextResponse.next();
    if (origin && isAllowedOrigin(origin)) {
      response.headers.set("Access-Control-Allow-Origin", origin);
    }
    addSecurityHeaders(response);
    return response;
  }

  const response = NextResponse.next();
  addSecurityHeaders(response);
  return response;
}

function addSecurityHeaders(response: NextResponse) {
  const isDev = process.env.NODE_ENV !== "production";
  const circuitCdnUrl = process.env.NEXT_PUBLIC_CIRCUIT_CDN_URL || "";
  let circuitOrigin = "";
  try {
    circuitOrigin = circuitCdnUrl ? new URL(circuitCdnUrl).origin : "";
  } catch {
    circuitOrigin = "";
  }
  const connectSrc = [
    "'self'",
    "https://api.binance.com",
    "https://api.coingecko.com",
    "https://*.helius-rpc.com",
    "https://api.devnet.solana.com",
    "https://api.mainnet-beta.solana.com",
    "https://mempool.space",
    "wss://mempool.space",
    "https://*.amidoggy.xyz",
    // utxopia.com subdomains: api (prod), api-hybrid (devnet+regtest), btc (regtest esplora)
    "https://*.utxopia.com",
    circuitOrigin,
  ]
    .filter(Boolean)
    .join(" ");

  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      `connect-src ${connectSrc}`,
      "frame-ancestors 'none'",
    ].join("; ")
  );
  if (process.env.NODE_ENV === "production") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
