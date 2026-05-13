import { describe, it, expect } from "bun:test";
import {
  buildUpdateAssociationRootInstructionData,
  buildAttestPoIInstructionData,
  ASSOCIATION_SET_SEED,
} from "../../src/poi-instructions";

describe("buildUpdateAssociationRootInstructionData", () => {
  it("packs disc(1) + root(32) + status(1) = 34 bytes", () => {
    const newRoot = new Uint8Array(32).fill(0xab);
    const data = buildUpdateAssociationRootInstructionData({ newRoot, status: 0 });
    expect(data.length).toBe(34);
    expect(data[0]).toBe(21);
    expect(Array.from(data.slice(1, 33))).toEqual(Array.from(newRoot));
    expect(data[33]).toBe(0);
  });

  it("rejects wrong-sized root", () => {
    expect(() =>
      buildUpdateAssociationRootInstructionData({
        newRoot: new Uint8Array(16),
        status: 0,
      }),
    ).toThrow();
  });
});

describe("buildAttestPoIInstructionData", () => {
  it("packs disc(1) + commitment(32) + proof(256) = 289 bytes", () => {
    const commitment = new Uint8Array(32).fill(0xcc);
    const proof = new Uint8Array(256).fill(0x77);
    const data = buildAttestPoIInstructionData({ commitment, proofBytes: proof });
    expect(data.length).toBe(289);
    expect(data[0]).toBe(22);
    expect(Array.from(data.slice(1, 33))).toEqual(Array.from(commitment));
    expect(data.slice(33)).toEqual(proof);
  });

  it("rejects wrong-sized commitment or proof", () => {
    expect(() =>
      buildAttestPoIInstructionData({
        commitment: new Uint8Array(16),
        proofBytes: new Uint8Array(256),
      }),
    ).toThrow();
    expect(() =>
      buildAttestPoIInstructionData({
        commitment: new Uint8Array(32),
        proofBytes: new Uint8Array(100),
      }),
    ).toThrow();
  });
});

describe("ASSOCIATION_SET_SEED", () => {
  it("matches the Rust constant", () => {
    expect(new TextDecoder().decode(ASSOCIATION_SET_SEED)).toBe("poi_association_set");
  });
});
