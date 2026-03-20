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
  if (ALLOWED_ORIGINS.length === 0) return true; // No constraint configured
  return ALLOWED_ORIGINS.some(
    (allowed) => origin === allowed || origin === allowed.replace(/\/$/, "")
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const origin = request.headers.get("origin");

  // ── Origin constraint for API routes ──
  if (pathname.startsWith("/api/")) {
    // Block cross-origin requests to sensitive relay endpoints
    if (!isAllowedOrigin(origin)) {
      return NextResponse.json(
        { success: false, error: "Forbidden: origin not allowed" },
        { status: 403 }
      );
    }

    // Handle CORS preflight
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

    // Set CORS headers on API responses
    const response = NextResponse.next();
    if (origin && isAllowedOrigin(origin)) {
      response.headers.set("Access-Control-Allow-Origin", origin);
    }
    addSecurityHeaders(response);
    return response;
  }

  // ── Security headers for all other routes ──
  const response = NextResponse.next();
  addSecurityHeaders(response);
  return response;
}

function addSecurityHeaders(response: NextResponse) {
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  if (process.env.NODE_ENV === "production") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
