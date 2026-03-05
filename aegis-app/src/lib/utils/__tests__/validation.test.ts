import { describe, it, expect } from "vitest";
import {
  validateDepositAmount,
  validateWithdrawalAmount,
  validateBtcAddress,
  parseSats,
  satsToBtc,
} from "../validation";

describe("validateDepositAmount", () => {
  it("returns valid for amounts within range", () => {
    expect(validateDepositAmount(10_000)).toEqual({ valid: true });
    expect(validateDepositAmount(1_000_000)).toEqual({ valid: true });
    expect(validateDepositAmount(100_000_000)).toEqual({ valid: true }); // 1 BTC
  });

  it("returns invalid for zero or negative amounts", () => {
    expect(validateDepositAmount(0).valid).toBe(false);
    expect(validateDepositAmount(-100).valid).toBe(false);
    expect(validateDepositAmount(0).error).toContain("greater than 0");
  });

  it("returns invalid for amounts below minimum", () => {
    const result = validateDepositAmount(500);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Minimum deposit");
  });

  it("returns invalid for amounts above maximum", () => {
    const result = validateDepositAmount(20_000_000_000); // 200 BTC
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Maximum deposit");
  });

  it("handles edge case at minimum boundary", () => {
    expect(validateDepositAmount(999).valid).toBe(false);
    expect(validateDepositAmount(1_000).valid).toBe(true);
  });
});

describe("validateWithdrawalAmount", () => {
  it("returns valid for amounts above minimum", () => {
    expect(validateWithdrawalAmount(1_000)).toEqual({ valid: true });
    expect(validateWithdrawalAmount(1_000_000)).toEqual({ valid: true });
  });

  it("returns invalid for zero or negative amounts", () => {
    expect(validateWithdrawalAmount(0).valid).toBe(false);
    expect(validateWithdrawalAmount(-50).valid).toBe(false);
  });

  it("returns invalid for amounts below minimum", () => {
    const result = validateWithdrawalAmount(500);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Minimum withdrawal");
  });

  it("handles edge case at minimum boundary", () => {
    expect(validateWithdrawalAmount(999).valid).toBe(false);
    expect(validateWithdrawalAmount(1_000).valid).toBe(true);
  });
});

describe("validateBtcAddress", () => {
  it("validates mainnet bech32 addresses", () => {
    expect(validateBtcAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").valid).toBe(true);
    expect(validateBtcAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").valid).toBe(true);
  });

  it("validates testnet bech32 addresses", () => {
    expect(validateBtcAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx").valid).toBe(true);
    expect(validateBtcAddress("tb1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqp3mvzv").valid).toBe(true);
  });

  it("validates legacy addresses", () => {
    expect(validateBtcAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa").valid).toBe(true);
    expect(validateBtcAddress("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy").valid).toBe(true);
  });

  it("returns invalid for empty addresses", () => {
    expect(validateBtcAddress("").valid).toBe(false);
    expect(validateBtcAddress("  ").valid).toBe(false);
    expect(validateBtcAddress("").error).toContain("required");
  });

  it("returns invalid for malformed addresses", () => {
    expect(validateBtcAddress("invalid").valid).toBe(false);
    expect(validateBtcAddress("bc1").valid).toBe(false);
    expect(validateBtcAddress("notabitcoinaddress12345").valid).toBe(false);
  });

  it("trims whitespace from addresses", () => {
    expect(validateBtcAddress("  bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq  ").valid).toBe(true);
  });
});

describe("parseSats", () => {
  it("parses valid integer strings", () => {
    expect(parseSats("100000")).toBe(100000);
    expect(parseSats("1")).toBe(1);
    expect(parseSats("999999999")).toBe(999999999);
  });

  it("returns null for invalid inputs", () => {
    expect(parseSats("")).toBeNull();
    expect(parseSats("abc")).toBeNull();
    expect(parseSats("12.34")).toBe(12); // parseInt behavior
    expect(parseSats("-100")).toBeNull();
    expect(parseSats("0")).toBeNull();
  });
});

describe("satsToBtc", () => {
  it("converts satoshis to BTC correctly", () => {
    expect(satsToBtc(100_000_000)).toBe(1);
    expect(satsToBtc(50_000_000)).toBe(0.5);
    expect(satsToBtc(1)).toBe(0.00000001);
    expect(satsToBtc(0)).toBe(0);
  });

  it("handles large values", () => {
    expect(satsToBtc(2_100_000_000_000_000)).toBe(21_000_000); // Max BTC supply
  });
});
