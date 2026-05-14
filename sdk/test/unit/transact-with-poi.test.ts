import { describe, it, expect } from "bun:test";
import { buildTransactWithPoIInstructionData } from "../../src/transact-with-poi";

const TRANSACT_WITH_POI_DISC = 26;
const PROOF = new Uint8Array(256).fill(0xab);
const SLOT32 = (b: number) => new Uint8Array(32).fill(b);

describe("buildTransactWithPoIInstructionData", () => {
  it("encodes the 419-byte instruction data with the right shape", () => {
    const data = buildTransactWithPoIInstructionData({
      proofBytes: PROOF,
      merkleRoot: SLOT32(0x01),
      boundParamsHash: SLOT32(0x02),
      nullifier: SLOT32(0x03),
      commitmentOut0: SLOT32(0x04),
      commitmentOut1: SLOT32(0x05),
    });
    // 1 (disc) + 1 (n_inputs) + 1 (n_outputs) + 256 (proof) + 5*32 = 419
    expect(data.length).toBe(1 + 1 + 1 + 256 + 32 * 5);
    expect(data[0]).toBe(TRANSACT_WITH_POI_DISC);
    expect(data[1]).toBe(1); // n_inputs (1x2 prototype)
    expect(data[2]).toBe(2); // n_outputs
    // proof bytes 3..259
    expect(data.slice(3, 259).every((b) => b === 0xab)).toBe(true);
    // public-input chunks
    expect(data.slice(259, 291).every((b) => b === 0x01)).toBe(true);
    expect(data.slice(291, 323).every((b) => b === 0x02)).toBe(true);
    expect(data.slice(323, 355).every((b) => b === 0x03)).toBe(true);
    expect(data.slice(355, 387).every((b) => b === 0x04)).toBe(true);
    expect(data.slice(387, 419).every((b) => b === 0x05)).toBe(true);
  });

  it("rejects malformed input sizes with a clear error", () => {
    const opts = {
      proofBytes: PROOF,
      merkleRoot: SLOT32(0x01),
      boundParamsHash: SLOT32(0x02),
      nullifier: SLOT32(0x03),
      commitmentOut0: SLOT32(0x04),
      commitmentOut1: SLOT32(0x05),
    };
    expect(() =>
      buildTransactWithPoIInstructionData({ ...opts, proofBytes: new Uint8Array(255) }),
    ).toThrow(/proofBytes/);
    expect(() =>
      buildTransactWithPoIInstructionData({ ...opts, merkleRoot: new Uint8Array(31) }),
    ).toThrow(/merkleRoot/);
    expect(() =>
      buildTransactWithPoIInstructionData({ ...opts, nullifier: new Uint8Array(33) }),
    ).toThrow(/nullifier/);
  });
});
