/**
 * RPC fallback tests — verifies instruction discriminator extraction
 *
 * The RPC fallback scans on-chain transaction logs when the
 * backend is unavailable. It must correctly detect:
 * - disc=1  → real BTC deposit
 * - disc=29 → SPL shield
 */

import { describe, it, expect } from "bun:test";

// =============================================================================
// Replicate the base58 decoder from rpc-fallback.ts
// =============================================================================

function decodeBase58(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes: number[] = [];
  for (const c of str) {
    let carry = ALPHABET.indexOf(c);
    if (carry < 0) return new Uint8Array(0);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const c of str) {
    if (c !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

function encodeBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let result = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    result += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += ALPHABET[digits[i]];
  }
  return result;
}

// =============================================================================
// Tests
// =============================================================================

describe("RPC fallback: instruction discriminator extraction", () => {
  const VERIFY_DISC = 1;
  const SHIELD_DISC = 29;
  const PRIVACY_COIN_PROGRAM_ID = "8fqRet9WB5PECvKfWmzTPSusJgQz1onzxTLfHD75XKim";

  /** Simulate extractInstructionDisc from rpc-fallback.ts */
  function extractInstructionDisc(result: any): number | null {
    try {
      const message = result.transaction?.message;
      const accountKeys: string[] = (message?.accountKeys ?? []).map(
        (k: string | { pubkey: string }) => (typeof k === "string" ? k : k.pubkey),
      );
      const instructions = message?.instructions ?? [];
      for (const ix of instructions) {
        const programIdx = ix.programIdIndex;
        if (accountKeys[programIdx] === PRIVACY_COIN_PROGRAM_ID && ix.data) {
          const decoded = decodeBase58(ix.data);
          if (decoded.length > 0) return decoded[0];
        }
      }
    } catch {}
    return null;
  }

  function buildMockTxResult(disc: number): any {
    // Build instruction data with discriminator as first byte
    const ixData = new Uint8Array(73);
    ixData[0] = disc;
    const encoded = encodeBase58(ixData);

    return {
      transaction: {
        message: {
          accountKeys: [
            "SomeUserKey111111111111111111111111111111111",
            PRIVACY_COIN_PROGRAM_ID,
            "11111111111111111111111111111111",
          ],
          instructions: [{
            programIdIndex: 1, // points to PRIVACY_COIN_PROGRAM_ID
            data: encoded,
            accounts: [0, 2],
          }],
        },
      },
      meta: { logMessages: [] },
    };
  }

  it("detects real BTC deposit (disc=1)", () => {
    const result = buildMockTxResult(VERIFY_DISC);
    expect(extractInstructionDisc(result)).toBe(1);
  });

  it("detects shield (disc=29)", () => {
    const result = buildMockTxResult(SHIELD_DISC);
    expect(extractInstructionDisc(result)).toBe(29);
  });

  it("returns null for non-PrivacyCoin transaction", () => {
    const result = {
      transaction: {
        message: {
          accountKeys: ["SomeOtherProgram111111111111111111111111111"],
          instructions: [{
            programIdIndex: 0,
            data: encodeBase58(new Uint8Array([42])),
            accounts: [],
          }],
        },
      },
    };
    expect(extractInstructionDisc(result)).toBeNull();
  });

  it("returns null for missing instruction data", () => {
    const result = {
      transaction: {
        message: {
          accountKeys: [PRIVACY_COIN_PROGRAM_ID],
          instructions: [{ programIdIndex: 0 }],
        },
      },
    };
    expect(extractInstructionDisc(result)).toBeNull();
  });
});

describe("Base58 encoding/decoding roundtrip", () => {
  it("roundtrips instruction data correctly", () => {
    const original = new Uint8Array([29, 0, 0, 0, 0, 0, 0xc3, 0x50]); // disc=29, amount=50000 LE
    const encoded = encodeBase58(original);
    const decoded = decodeBase58(encoded);
    expect(decoded).toEqual(original);
  });

  it("handles zero-prefixed bytes", () => {
    const data = new Uint8Array([0, 0, 13, 1, 2, 3]);
    const encoded = encodeBase58(data);
    const decoded = decodeBase58(encoded);
    expect(decoded).toEqual(data);
  });
});
