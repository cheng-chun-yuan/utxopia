import { describe, it, expect } from "bun:test";
import {
  parseSnsStealthData,
  isAuditorDisclosable,
  SnsComplianceFlags,
  SNS_STEALTH_DATA_SIZE,
  type SnsStealthAddress,
} from "../../src/sns-resolver";

const SNS_HEADER_SIZE = 96;

/** Build a synthetic SNS account: header + payload. Header bytes are
 *  irrelevant to the parser (it skips them), so they're zero-filled here. */
function buildAccount(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(SNS_HEADER_SIZE + payload.length);
  out.set(payload, SNS_HEADER_SIZE);
  return out;
}

/** Standard v2 stealth payload with optional trailing flag byte. */
function v2Payload(opts: {
  viewingPubKey?: Uint8Array;
  mpk?: Uint8Array;
  trailingFlag?: number;
}): Uint8Array {
  const viewing = opts.viewingPubKey ?? new Uint8Array(32).fill(0x11);
  const mpk = opts.mpk ?? new Uint8Array(32).fill(0x22);
  const size = SNS_STEALTH_DATA_SIZE + (opts.trailingFlag !== undefined ? 1 : 0);
  const buf = new Uint8Array(size);
  buf[0] = 2; // version
  buf.set(viewing, 1);
  buf.set(mpk, 33);
  if (opts.trailingFlag !== undefined) {
    buf[SNS_STEALTH_DATA_SIZE] = opts.trailingFlag;
  }
  return buf;
}

describe("parseSnsStealthData — compliance flags back-compat", () => {
  it("returns complianceFlags=0 for a legacy 65-byte payload (no extra byte)", () => {
    const parsed = parseSnsStealthData(buildAccount(v2Payload({})));
    expect(parsed).not.toBeNull();
    expect(parsed!.complianceFlags).toBe(0);
    expect(parsed!.version).toBe(2);
  });

  it("reads complianceFlags from the optional 66-byte payload", () => {
    const parsed = parseSnsStealthData(
      buildAccount(v2Payload({ trailingFlag: SnsComplianceFlags.AUDITOR_DISCLOSABLE })),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.complianceFlags).toBe(SnsComplianceFlags.AUDITOR_DISCLOSABLE);
  });

  it("preserves unrelated bits (forward-compat for future flag bits)", () => {
    // 0b00000110 — bits 1 and 2 set; bit 0 (AUDITOR_DISCLOSABLE) clear.
    // The reader should still surface the raw byte; only `isAuditorDisclosable`
    // narrows to bit 0.
    const parsed = parseSnsStealthData(buildAccount(v2Payload({ trailingFlag: 0b110 })));
    expect(parsed!.complianceFlags).toBe(0b110);
  });

  it("rejects accounts that are too small to hold a stealth payload", () => {
    // Header + 64 bytes < required 65; null.
    const tiny = new Uint8Array(SNS_HEADER_SIZE + SNS_STEALTH_DATA_SIZE - 1);
    expect(parseSnsStealthData(tiny)).toBeNull();
  });
});

describe("isAuditorDisclosable", () => {
  function fakeAddr(flags: number): SnsStealthAddress {
    return {
      name: "alice",
      fullDomain: "alice.btcpro.sol",
      viewingPubKey: new Uint8Array(32),
      mpk: new Uint8Array(32),
      version: 2,
      complianceFlags: flags,
    };
  }

  it("true only when bit 0 is set", () => {
    expect(isAuditorDisclosable(fakeAddr(0))).toBe(false);
    expect(isAuditorDisclosable(fakeAddr(SnsComplianceFlags.AUDITOR_DISCLOSABLE))).toBe(true);
    // Other bits don't trigger it
    expect(isAuditorDisclosable(fakeAddr(0b10))).toBe(false);
    // Bit 0 still wins even when other bits are set
    expect(isAuditorDisclosable(fakeAddr(0b11))).toBe(true);
  });
});
