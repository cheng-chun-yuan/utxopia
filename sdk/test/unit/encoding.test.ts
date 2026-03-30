import { describe, it, expect } from "bun:test";
import { toHex, fromHex, fromBase64, base64ToBinaryString } from "../../src/utils/encoding";

describe("toHex / fromHex", () => {
  it("roundtrips a single byte", () => {
    const bytes = new Uint8Array([0xab]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it("roundtrips empty array", () => {
    const bytes = new Uint8Array([]);
    expect(toHex(bytes)).toBe("");
    expect(fromHex("")).toEqual(bytes);
  });

  it("roundtrips multiple bytes", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x7f, 0x80, 0x01]);
    const hex = toHex(bytes);
    expect(hex).toBe("00ff7f8001");
    expect(fromHex(hex)).toEqual(bytes);
  });

  it("roundtrips a 32-byte value", () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i;
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it("fromHex strips 0x prefix", () => {
    expect(fromHex("0xab")).toEqual(new Uint8Array([0xab]));
  });

  it("toHex pads single-digit hex values", () => {
    const bytes = new Uint8Array([0, 1, 2]);
    expect(toHex(bytes)).toBe("000102");
  });
});

describe("fromBase64", () => {
  it("decodes a known base64 string", () => {
    // "SGVsbG8=" = "Hello"
    const result = fromBase64("SGVsbG8=");
    expect(result).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
  });

  it("decodes empty base64", () => {
    expect(fromBase64("")).toEqual(new Uint8Array([]));
  });

  it("decodes base64 with padding", () => {
    // "YQ==" = "a"
    const result = fromBase64("YQ==");
    expect(result).toEqual(new Uint8Array([97]));
  });

  it("decodes binary data from base64", () => {
    // "/w==" = 0xff
    const result = fromBase64("/w==");
    expect(result).toEqual(new Uint8Array([255]));
  });
});

describe("base64ToBinaryString", () => {
  it("returns a binary string from base64", () => {
    const result = base64ToBinaryString("SGVsbG8=");
    expect(result).toBe("Hello");
  });

  it("each char code equals the corresponding byte", () => {
    const b64 = "AAEC"; // [0, 1, 2]
    const str = base64ToBinaryString(b64);
    expect(str.length).toBe(3);
    expect(str.charCodeAt(0)).toBe(0);
    expect(str.charCodeAt(1)).toBe(1);
    expect(str.charCodeAt(2)).toBe(2);
  });

  it("handles empty input", () => {
    expect(base64ToBinaryString("")).toBe("");
  });
});
