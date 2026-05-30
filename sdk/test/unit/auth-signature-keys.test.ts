import { describe, expect, test } from "bun:test";
import {
  createStealthMetaAddress,
  deriveKeysFromAuthSignature,
  generateRandomAuthSignature,
  setupKeysFromAuthSignature,
} from "../../src/keys";

describe("auth signature key derivation", () => {
  test("accepts Fluidkey-style 65-byte signatures", () => {
    const signature = new Uint8Array(65).fill(7);
    signature[64] = 27;
    const keys = deriveKeysFromAuthSignature(signature, {
      account: "0xsui",
      chain: "sui",
      network: "testnet",
    });

    expect(keys.spendingPrivKey).toBeTypeOf("bigint");
    expect(keys.nullifyingKey).toBeTypeOf("bigint");
    expect(keys.viewingPrivKey.length).toBe(32);
    expect(keys.viewingPubKey.length).toBe(32);
    expect(keys.eddsaSeed.length).toBe(32);
    expect(createStealthMetaAddress(keys).mpk.length).toBe(32);
  });

  test("is deterministic for the same signature and context", () => {
    const signature = new Uint8Array(65).fill(9);
    const a = deriveKeysFromAuthSignature(signature, { account: "alice" });
    const b = deriveKeysFromAuthSignature(signature, { account: "alice" });

    expect(a.spendingPrivKey).toBe(b.spendingPrivKey);
    expect(a.nullifyingKey).toBe(b.nullifyingKey);
    expect(a.viewingPubKey).toEqual(b.viewingPubKey);
  });

  test("domain context changes derived keys", () => {
    const signature = new Uint8Array(65).fill(9);
    const a = deriveKeysFromAuthSignature(signature, { account: "alice" });
    const b = deriveKeysFromAuthSignature(signature, { account: "bob" });

    expect(a.spendingPrivKey).not.toBe(b.spendingPrivKey);
    expect(a.nullifyingKey).not.toBe(b.nullifyingKey);
    expect(a.viewingPubKey).not.toEqual(b.viewingPubKey);
  });

  test("sets up an encoded stealth address from a random test signature", () => {
    const setup = setupKeysFromAuthSignature(generateRandomAuthSignature(), {
      account: "agent-browser-test",
      chain: "sui",
      network: "sui-regtest",
    });

    expect(setup.root.length).toBe(32);
    expect(setup.encodedStealthAddress.startsWith("utxo:")).toBe(true);
    expect(setup.stealthMetaAddress.viewingPubKey.length).toBe(32);
  });
});
