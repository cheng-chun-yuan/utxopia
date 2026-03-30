import { describe, it, expect } from "bun:test";
import { encodeClaimLink, decodeClaimLink, parseClaimUrl } from "../../src/claim-link";

describe("encodeClaimLink / decodeClaimLink", () => {
  it("roundtrips a simple seed", () => {
    const seed = "mysecret12345678";
    const encoded = encodeClaimLink(seed);
    expect(decodeClaimLink(encoded)).toBe(seed);
  });

  it("roundtrips a seed with special characters", () => {
    const seed = "test seed with spaces & symbols!";
    const encoded = encodeClaimLink(seed);
    expect(decodeClaimLink(encoded)).toBe(seed);
  });

  it("decodeClaimLink returns null for short strings (< 8 chars)", () => {
    expect(decodeClaimLink("short")).toBeNull();
  });

  it("decodeClaimLink returns null for strings not starting with alphanumeric", () => {
    expect(decodeClaimLink("%21abcdefgh")).toBeNull(); // decodes to "!abcdefgh"
  });

  it("decodeClaimLink returns null for invalid URI encoding", () => {
    expect(decodeClaimLink("%ZZinvalid")).toBeNull();
  });
});

describe("parseClaimUrl", () => {
  it("extracts seed from #note= fragment", () => {
    const seed = "mysecretphrase12";
    const url = `https://example.com/claim#note=${encodeClaimLink(seed)}`;
    expect(parseClaimUrl(url)).toBe(seed);
  });

  it("extracts seed from ?note= query param", () => {
    const seed = "queryseed1234567";
    const url = `https://example.com/claim?note=${encodeClaimLink(seed)}`;
    expect(parseClaimUrl(url)).toBe(seed);
  });

  it("prefers #note= over ?note=", () => {
    const hashSeed = "hashseedvalue123";
    const querySeed = "queryseedvalue12";
    const url = `https://example.com?note=${encodeClaimLink(querySeed)}#note=${encodeClaimLink(hashSeed)}`;
    expect(parseClaimUrl(url)).toBe(hashSeed);
  });

  it("returns null for missing fragment and query", () => {
    expect(parseClaimUrl("https://example.com/claim")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseClaimUrl("")).toBeNull();
  });

  it("works with URLSearchParams", () => {
    const seed = "paramsseed123456";
    const params = new URLSearchParams(`note=${encodeClaimLink(seed)}`);
    expect(parseClaimUrl(params)).toBe(seed);
  });

  it("returns null for URLSearchParams without note", () => {
    const params = new URLSearchParams("foo=bar");
    expect(parseClaimUrl(params)).toBeNull();
  });
});
