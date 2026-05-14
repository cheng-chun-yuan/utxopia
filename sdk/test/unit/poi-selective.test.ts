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
  pickRangeSumVariant,
  computeRangeSumAttestation,
  RANGE_SUM_VARIANTS,
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
  it("generateRangeSumProof rejects an uncompiled cardinality", async () => {
    // Zero-length input has no compiled variant, so the dispatcher refuses.
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
    ).rejects.toThrow(/no compiled variant/);
  });

  // generateOwnershipProof exists and accepts shaped input; we don't run the
  // full prover here because that requires circuit artifacts on disk + snarkjs.
  // The smoke test in scripts/auditor/prove-ownership.ts (Task 4b CLI) covers
  // end-to-end proof generation.
  it("generateOwnershipProof is a real function", () => {
    expect(typeof generateOwnershipProof).toBe("function");
  });
});

describe("Range-sum variants registry", () => {
  it("registers N=4 flat, N=8 flat, N=16 chunked", () => {
    expect(RANGE_SUM_VARIANTS.map((v) => v.n)).toEqual([4, 8, 16]);
    expect(pickRangeSumVariant(4).attestation).toBe("flat");
    expect(pickRangeSumVariant(8).attestation).toBe("flat");
    expect(pickRangeSumVariant(16).attestation).toBe("chunked");
  });

  it("circuit name matches the directory layout", () => {
    expect(pickRangeSumVariant(4).circuit).toBe("range_sum_4");
    expect(pickRangeSumVariant(8).circuit).toBe("range_sum");
    expect(pickRangeSumVariant(16).circuit).toBe("range_sum_16");
  });

  it("throws a helpful error for unknown N", () => {
    expect(() => pickRangeSumVariant(7)).toThrow(/no compiled variant/);
    expect(() => pickRangeSumVariant(32)).toThrow(/Compiled variants: 4, 8, 16/);
  });
});

describe("computeRangeSumAttestation", () => {
  const leafIndices8 = [10, 20, 30, 40, 50, 60, 70, 80];
  const leafIndices16 = [
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16,
  ];
  const nonce = 999n;

  it("is deterministic for flat N=8", async () => {
    const a = await computeRangeSumAttestation(leafIndices8, nonce);
    const b = await computeRangeSumAttestation(leafIndices8, nonce);
    expect(a).toBe(b);
  });

  it("is deterministic for chunked N=16", async () => {
    const a = await computeRangeSumAttestation(leafIndices16, nonce);
    const b = await computeRangeSumAttestation(leafIndices16, nonce);
    expect(a).toBe(b);
  });

  it("differs across different viewer nonces (binding)", async () => {
    const a = await computeRangeSumAttestation(leafIndices8, 1n);
    const b = await computeRangeSumAttestation(leafIndices8, 2n);
    expect(a).not.toBe(b);
  });

  it("differs across different leaf-index sets (binding)", async () => {
    const a = await computeRangeSumAttestation(leafIndices8, nonce);
    const b = await computeRangeSumAttestation([...leafIndices8.slice(0, 7), 999], nonce);
    expect(a).not.toBe(b);
  });

  it("flat and chunked produce distinct values for the same N when both styles are valid", async () => {
    // N=8 fits both styles; the registry says flat, but the helper accepts
    // an explicit style override.
    const flat = await computeRangeSumAttestation(leafIndices8, nonce, "flat");
    const chunked = await computeRangeSumAttestation(leafIndices8, nonce, "chunked");
    expect(flat).not.toBe(chunked);
  });

  it("chunked rejects odd cardinalities", async () => {
    await expect(
      computeRangeSumAttestation([1, 2, 3], 0n, "chunked"),
    ).rejects.toThrow(/even cardinality/);
  });
});
