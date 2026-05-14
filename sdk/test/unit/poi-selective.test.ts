import { describe, it, expect } from "bun:test";
import {
  POI_TREE_DEPTH,
  poiLeafHash,
  generatePoIProof,
  fetchPoIInclusion,
  computeBlindedId,
  generateHiddenPoINonce,
  HIDDEN_POI_NONCE_BYTES,
} from "../../src/poi";
import {
  buildAttestPoIHiddenInstructionData,
} from "../../src/poi-instructions";
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

describe("Hidden-commitment PoI (Phase 3d-lite)", () => {
  it("computeBlindedId is deterministic", async () => {
    const a = await computeBlindedId(0x42n, 0x99n);
    const b = await computeBlindedId(0x42n, 0x99n);
    expect(a).toBe(b);
    // and the result is a valid BN254 field element
    const BN254_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    expect(a).toBeLessThan(BN254_PRIME);
    expect(a).toBeGreaterThan(0n);
  });

  it("computeBlindedId binds the commitment to the nonce", async () => {
    const c1 = await computeBlindedId(1n, 99n);
    const c2 = await computeBlindedId(2n, 99n);   // same nonce, different commitment
    const c3 = await computeBlindedId(1n, 100n);  // different nonce, same commitment
    expect(c1).not.toBe(c2);
    expect(c1).not.toBe(c3);
    expect(c2).not.toBe(c3);
  });

  it("generateHiddenPoINonce produces 240-bit values", () => {
    const n = generateHiddenPoINonce();
    expect(n).toBeGreaterThanOrEqual(0n);
    expect(n).toBeLessThan(1n << BigInt(HIDDEN_POI_NONCE_BYTES * 8));
    // Almost surely > 0 unless we drew the all-zero bytes, which has
    // probability 2^-240. Sanity check:
    expect(n).not.toBe(0n);
  });

  it("generateHiddenPoINonce returns different values across calls", () => {
    const a = generateHiddenPoINonce();
    const b = generateHiddenPoINonce();
    expect(a).not.toBe(b);
  });

  it("buildAttestPoIHiddenInstructionData encodes 289 bytes with disc 23", () => {
    const blindedId = new Uint8Array(32).fill(0xab);
    const proofBytes = new Uint8Array(256).fill(0xcd);
    const data = buildAttestPoIHiddenInstructionData({ blindedId, proofBytes });
    expect(data.length).toBe(1 + 32 + 256);
    expect(data[0]).toBe(23); // ATTEST_POI_HIDDEN discriminator
    expect(data.slice(1, 33)).toEqual(blindedId);
    expect(data.slice(33).every((b) => b === 0xcd)).toBe(true);
  });

  it("buildAttestPoIHiddenInstructionData rejects malformed inputs", () => {
    expect(() =>
      buildAttestPoIHiddenInstructionData({
        blindedId: new Uint8Array(31),
        proofBytes: new Uint8Array(256),
      }),
    ).toThrow(/blindedId/);
    expect(() =>
      buildAttestPoIHiddenInstructionData({
        blindedId: new Uint8Array(32),
        proofBytes: new Uint8Array(255),
      }),
    ).toThrow(/proofBytes/);
  });
});
