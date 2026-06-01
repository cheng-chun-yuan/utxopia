/** @happy-dom */
import { describe, it, expect } from "bun:test";
import { detectRecipient } from "./recipient-detect";

describe("detectRecipient", () => {
  it("returns 'empty' for empty / whitespace input", () => {
    expect(detectRecipient("").type).toBe("empty");
    expect(detectRecipient("   ").type).toBe("empty");
  });

  it("detects .utxopia.sol as stealth_sns", () => {
    const r = detectRecipient("alice.utxopia.sol");
    expect(r.type).toBe("stealth_sns");
    expect(r.confidence).toBe("high");
  });

  it("detects bech32 BTC mainnet addresses (bc1...)", () => {
    const r = detectRecipient("bc1q9d4ywgfnd8h70q4thlsclpw0ymmqfumzgxlhpe");
    expect(r.type).toBe("btc");
    expect(r.confidence).toBe("high");
  });

  it("detects bech32 testnet (tb1...) and regtest (bcrt1...)", () => {
    expect(
      detectRecipient(
        "tb1pelu63s2nzxvj5ezr05jxdf9dyq9pgkn3qzxq6jgcvwhg2vu0d62qq6yg2j",
      ).type,
    ).toBe("btc");
    expect(
      detectRecipient(
        "bcrt1pdsvdn95vcdsjwz92tc4x5y8w026hur8ud7nvae65y4rvsjsqe8fq5j9s56",
      ).type,
    ).toBe("btc");
  });

  it("detects legacy P2PKH ('1...') and P2SH ('3...') as btc with medium confidence", () => {
    const r1 = detectRecipient("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    expect(r1.type).toBe("btc");
    expect(r1.confidence).toBe("medium");
    const r3 = detectRecipient("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy");
    expect(r3.type).toBe("btc");
  });

  it("detects Solana base58 pubkey (44 chars) as spl_wallet", () => {
    const r = detectRecipient("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    expect(r.type).toBe("spl_wallet");
    expect(r.confidence).toBe("medium");
  });

  it("detects stealth meta-address (hex prefix 'utxo:')", () => {
    // 96 bytes = spendingPubKey(32) + viewingPubKey(32) + mpk(32)
    const meta = "utxo:" + "01".repeat(32) + "02".repeat(32) + "03".repeat(32);
    const r = detectRecipient(meta);
    expect(r.type).toBe("stealth_meta");
    expect(r.confidence).toBe("high");
  });

  it("rejects old 64-byte stealth meta-address (pre-mpk format)", () => {
    // Defensive: the SDK now requires 96 bytes (spending + viewing + mpk).
    // A 64-byte form would slip through decode and crash downstream.
    const tooShort = "utxo:" + "01".repeat(32) + "02".repeat(32);
    const r = detectRecipient(tooShort);
    expect(r.type).toBe("invalid");
  });

  it("accepts the real-world 192-hex stealth address from scripts/deposit-for-stealth.ts", () => {
    const real =
      "utxo:4ef071c344e4a5b1f57740bcf44015c60df8d41b0953fcef490524a0ea456eac" +
      "d39603c83b1d5f68f129d3dca76881a100b37fa933f0868b6b57d2000056c58c" +
      "0491ab4fda32563217868f2739b0b87419ca296729ad6f0c60e203292b54ac7b";
    const r = detectRecipient(real);
    expect(r.type).toBe("stealth_meta");
    expect(r.confidence).toBe("high");
  });

  it("returns invalid for garbage input", () => {
    expect(detectRecipient("not a valid address").type).toBe("invalid");
    expect(detectRecipient("xxxxxxxxxxxxxx").type).toBe("invalid");
  });

  it("classifies short-but-bech32-shaped input as btc (checksum is the SDK's job downstream)", () => {
    // Truncated bech32. We don't validate the checksum here on purpose —
    // the SDK's downstream validation catches it. This function only
    // needs to be sharp enough to drive the type indicator.
    const r = detectRecipient("bc1q9d4ywgfnd8h70q4thlsclpw0ymmqfumzgxlhp");
    expect(r.type).toBe("btc");
  });

  it("returns invalid for prefix-only bech32-ish input", () => {
    const r = detectRecipient("bc1");
    expect(r.type).toBe("invalid");
  });
});
