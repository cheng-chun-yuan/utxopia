import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getBackendUrl, DEFAULT_API_URL } from "../constants";

// Note: vitest runs with jsdom (window is defined), so getBackendUrl()
// takes the client-side branch (NEXT_PUBLIC_BACKEND_API_URL).

describe("getBackendUrl", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BACKEND_API_URL;
    delete process.env.NEXT_PUBLIC_BACKEND_API_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns DEFAULT_API_URL when no env vars set", () => {
    expect(getBackendUrl()).toBe(DEFAULT_API_URL);
  });

  it("uses NEXT_PUBLIC_BACKEND_API_URL on client side", () => {
    process.env.NEXT_PUBLIC_BACKEND_API_URL = "https://api-aegis.amidoggy.xyz";
    expect(getBackendUrl()).toBe("https://api-aegis.amidoggy.xyz");
  });
});
