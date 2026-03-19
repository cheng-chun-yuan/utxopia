import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getBackendUrl, DEFAULT_API_URL } from "../constants";

// Note: vitest runs with jsdom (window is defined), so getBackendUrl()
// takes the client-side branch (NEXT_PUBLIC_* env vars).

describe("getBackendUrl", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.TRACKER_API_URL;
    delete process.env.BACKEND_URL;
    delete process.env.NEXT_PUBLIC_ZKBTC_API_URL;
    delete process.env.NEXT_PUBLIC_BACKEND_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns DEFAULT_API_URL when no env vars set", () => {
    expect(getBackendUrl()).toBe(DEFAULT_API_URL);
  });

  it("prefers NEXT_PUBLIC_ZKBTC_API_URL on client side", () => {
    process.env.NEXT_PUBLIC_ZKBTC_API_URL = "http://zkbtc-api:3001";
    process.env.NEXT_PUBLIC_BACKEND_URL = "http://backend:8080";
    expect(getBackendUrl()).toBe("http://zkbtc-api:3001");
  });

  it("falls back to NEXT_PUBLIC_BACKEND_URL", () => {
    process.env.NEXT_PUBLIC_BACKEND_URL = "http://backend:8080";
    expect(getBackendUrl()).toBe("http://backend:8080");
  });
});
