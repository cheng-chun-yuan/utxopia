/**
 * Server-side API authentication for relay endpoints.
 *
 * Validates the X-API-Key header against RELAY_API_KEY env var.
 * Used by relay, unshield, and redeem routes to prevent unauthorized
 * access that could drain the relayer's SOL balance.
 */
import { NextResponse } from "next/server";

const RELAY_API_KEY = process.env.RELAY_API_KEY || process.env.BACKEND_API_KEY || "";

/**
 * Validate API key from request headers.
 * Returns null if valid, or an error NextResponse if invalid.
 */
export function validateApiKey(request: Request): NextResponse | null {
  if (!RELAY_API_KEY) {
    // No key configured — allow in dev, block in prod
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { success: false, error: "Relay API key not configured" },
        { status: 500 }
      );
    }
    return null; // Allow in dev without key
  }

  const apiKey = request.headers.get("X-API-Key") || request.headers.get("x-api-key");
  if (!apiKey || apiKey !== RELAY_API_KEY) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  return null; // Valid
}
