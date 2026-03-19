import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRelayerKeypair } from "../relayer";

describe("getRelayerKeypair", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when RELAYER_KEYPAIR is not set", () => {
    delete process.env.RELAYER_KEYPAIR;
    expect(getRelayerKeypair()).toBeNull();
  });

  it("returns null when RELAYER_KEYPAIR is invalid JSON", () => {
    process.env.RELAYER_KEYPAIR = "not-json";
    expect(getRelayerKeypair()).toBeNull();
  });

  it("returns null when RELAYER_KEYPAIR is empty string", () => {
    process.env.RELAYER_KEYPAIR = "";
    expect(getRelayerKeypair()).toBeNull();
  });

  it("returns Keypair when RELAYER_KEYPAIR is valid", () => {
    // Generate a valid 64-byte secret key array (all 1s is not a valid key, use a known test vector)
    // Keypair.generate() internally, but we need deterministic — use a fixed secret
    const { Keypair } = require("@solana/web3.js");
    const testKeypair = Keypair.generate();
    process.env.RELAYER_KEYPAIR = JSON.stringify(Array.from(testKeypair.secretKey));

    const result = getRelayerKeypair();
    expect(result).not.toBeNull();
    expect(result!.publicKey.toBase58()).toBe(testKeypair.publicKey.toBase58());
  });
});
