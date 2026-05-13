import { describe, it, expect } from "bun:test";
import {
  POI_TREE_DEPTH,
  poiLeafHash,
  generatePoIProof,
  fetchPoIInclusion,
} from "../../src/poi";
import {
  generateOwnershipProof,
  generateRangeSumProof,
} from "../../src/selective-disclosure";

describe("PoI module — skeleton", () => {
  it("POI_TREE_DEPTH matches the circuit (20)", () => {
    expect(POI_TREE_DEPTH).toBe(20);
  });

  it("poiLeafHash returns the commitment unchanged in v1", () => {
    expect(poiLeafHash(42n)).toBe(42n);
  });

  it("generatePoIProof rejects wrong path length", async () => {
    await expect(
      generatePoIProof({
        associationRoot: 0n,
        commitment: 0n,
        pathElements: [],
        pathIndices: [],
      }),
    ).rejects.toThrow(/path elements/);
  });

  it("fetchPoIInclusion handles 404", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 404 })) as typeof fetch;
    try {
      const r = await fetchPoIInclusion("https://example.com", 0n);
      expect(r).toBeNull();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("fetchPoIInclusion decodes a found inclusion proof", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          found: true,
          association_root: "ab",
          path_elements: ["01", "02"],
          path_indices: [0, 1],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const r = await fetchPoIInclusion("https://example.com", 0n);
      expect(r).not.toBeNull();
      expect(r!.associationRoot).toBe(0xabn);
      expect(r!.pathElements).toEqual([1n, 2n]);
      expect(r!.pathIndices).toEqual([0, 1]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("Selective disclosure module — skeleton", () => {
  it("generateRangeSumProof rejects wrong note count", async () => {
    await expect(
      generateRangeSumProof({
        notes: [],
        spendingPrivScalar: 0n,
        nullifyingKey: 0n,
        merkleRoot: 0n,
        ceiling: 0n,
        tokenId: 0n,
        viewerNonce: 0n,
        attestation: 0n,
      }),
    ).rejects.toThrow(/exactly 8 notes/);
  });

  // generateOwnershipProof exists and accepts shaped input; we don't run the
  // full prover here because that requires circuit artifacts on disk + snarkjs.
  // The smoke test in scripts/auditor/prove-ownership.ts (Task 4b CLI) covers
  // end-to-end proof generation.
  it("generateOwnershipProof is a real function", () => {
    expect(typeof generateOwnershipProof).toBe("function");
  });
});
