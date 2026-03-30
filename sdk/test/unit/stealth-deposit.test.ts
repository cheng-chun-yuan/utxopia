import { describe, it, expect } from "bun:test";
import {
  buildStealthOpReturn,
  parseStealthOpReturn,
  STEALTH_OP_RETURN_SIZE,
} from "../../src/stealth-deposit";

describe("STEALTH_OP_RETURN_SIZE", () => {
  it("equals 32", () => {
    expect(STEALTH_OP_RETURN_SIZE).toBe(32);
  });
});

describe("buildStealthOpReturn / parseStealthOpReturn", () => {
  it("roundtrips a 32-byte commitment", () => {
    const commitment = new Uint8Array(32);
    for (let i = 0; i < 32; i++) commitment[i] = i;

    const payload = buildStealthOpReturn({ commitment });
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(payload.length).toBe(STEALTH_OP_RETURN_SIZE);

    const parsed = parseStealthOpReturn(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.commitment).toEqual(commitment);
  });

  it("returns a copy (not the same reference)", () => {
    const commitment = new Uint8Array(32).fill(0xaa);
    const payload = buildStealthOpReturn({ commitment });

    // buildStealthOpReturn creates a new Uint8Array
    expect(payload).not.toBe(commitment);
    expect(payload).toEqual(commitment);

    // parseStealthOpReturn also creates a new copy
    const parsed = parseStealthOpReturn(payload);
    expect(parsed!.commitment).not.toBe(payload);
    expect(parsed!.commitment).toEqual(payload);
  });

  it("parseStealthOpReturn returns null for wrong-length data", () => {
    expect(parseStealthOpReturn(new Uint8Array(31))).toBeNull();
    expect(parseStealthOpReturn(new Uint8Array(33))).toBeNull();
    expect(parseStealthOpReturn(new Uint8Array(64))).toBeNull();
    expect(parseStealthOpReturn(new Uint8Array(0))).toBeNull();
  });

  it("handles all-zero commitment", () => {
    const commitment = new Uint8Array(32);
    const payload = buildStealthOpReturn({ commitment });
    const parsed = parseStealthOpReturn(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.commitment).toEqual(commitment);
  });

  it("handles all-0xff commitment", () => {
    const commitment = new Uint8Array(32).fill(0xff);
    const payload = buildStealthOpReturn({ commitment });
    const parsed = parseStealthOpReturn(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.commitment).toEqual(commitment);
  });
});
