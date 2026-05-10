/** @happy-dom */
import { describe, it, expect } from "bun:test";
import { detectRecipient } from "./recipient-detect";

describe("detectRecipient", () => {
  it("returns 'empty' for empty / whitespace input", () => {
    expect(detectRecipient("").type).toBe("empty");
    expect(detectRecipient("   ").type).toBe("empty");
  });

  it("detects .btcpro.sol as stealth_sns", () => {
    const r = detectRecipient("alice.btcpro.sol");
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

  it("detects stealth meta-address (hex prefix 'pcoin:')", () => {
    const meta = "pcoin:" + "01".repeat(32) + "02".repeat(32);
    const r = detectRecipient(meta);
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
