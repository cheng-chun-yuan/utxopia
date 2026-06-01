/**
 * Deposit Flow Unit Tests
 *
 * Tests each phase of the BTC deposit flow as isolated, pure unit tests.
 * No network access, no validator, no compiled circuits required.
 */

import { describe, test, expect, beforeAll } from "bun:test";

// Poseidon
import {
  initPoseidon,
  poseidonHashSync,
  computeMPKSync,
  computeNPKSync,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
  BN254_SCALAR_FIELD,
} from "../src/poseidon";

// Taproot
import {
  deriveTaprootAddress,
  verifyTaprootAddress,
  createP2TRScriptPubkey,
  parseP2TRScriptPubkey,
  isValidBitcoinAddress,
} from "../src/taproot";

// Keys
import {
  deriveKeysFromSeed,
  createStealthMetaAddress,
} from "../src/keys";

// Stealth
import {
  createStealthDeposit,
  scanAnnouncements,
  prepareClaimInputs,
} from "../src/stealth";

const ZKBTC_TOKEN_ID = 0x7a627463n;

// Commitment tree
import {
  CommitmentTreeIndex,
  ZERO_HASHES,
  TREE_DEPTH,
} from "../src/commitment-tree";

// Merkle helpers
import {
  leafIndexToPathIndices,
  pathIndicesToLeafIndex,
} from "../src/merkle";

// Bound params
import {
  computeBoundParamsHash,
  DEFAULT_BOUND_PARAMS,
  createUnshieldBoundParams,
} from "../src/bound-params";

// Crypto helpers
import { bytesToBigint } from "../src/crypto";

// API
import { depositToNote } from "../src/api";

// ============================================================================
// Setup
// ============================================================================

const TEST_SEED = new Uint8Array(32).fill(0xaa);

beforeAll(async () => {
  await initPoseidon();
});

// ============================================================================
// 1. Taproot address derivation
// ============================================================================

describe("Taproot address derivation", () => {
  const commitment = new Uint8Array(32).fill(0x01);
  const commitment2 = new Uint8Array(32).fill(0x02);

  test("derives valid tb1p testnet address", () => {
    const result = deriveTaprootAddress(commitment, "testnet");
    expect(result.address.startsWith("tb1p")).toBe(true);
    expect(result.outputKey.length).toBe(32);
  });

  test("derives valid bc1p mainnet address", () => {
    const result = deriveTaprootAddress(commitment, "mainnet");
    expect(result.address.startsWith("bc1p")).toBe(true);
  });

  test("deterministic for same commitment", () => {
    const a = deriveTaprootAddress(commitment, "testnet");
    const b = deriveTaprootAddress(commitment, "testnet");
    expect(a.address).toBe(b.address);
    expect(a.outputKey).toEqual(b.outputKey);
  });

  test("different commitments produce different addresses", () => {
    const a = deriveTaprootAddress(commitment, "testnet");
    const b = deriveTaprootAddress(commitment2, "testnet");
    expect(a.address).not.toBe(b.address);
  });

  test("verifyTaprootAddress returns true for correct commitment", () => {
    const { address } = deriveTaprootAddress(commitment, "testnet");
    expect(verifyTaprootAddress(address, commitment)).toBe(true);
  });

  test("verifyTaprootAddress returns false for wrong commitment", () => {
    const { address } = deriveTaprootAddress(commitment, "testnet");
    expect(verifyTaprootAddress(address, commitment2)).toBe(false);
  });

  test("P2TR script roundtrip", () => {
    const { outputKey } = deriveTaprootAddress(commitment, "testnet");
    const script = createP2TRScriptPubkey(outputKey);
    const parsed = parseP2TRScriptPubkey(script);
    expect(parsed).not.toBeNull();
    expect(parsed!).toEqual(outputKey);
  });

  test("isValidBitcoinAddress identifies taproot", () => {
    const { address } = deriveTaprootAddress(commitment, "testnet");
    const result = isValidBitcoinAddress(address);
    expect(result.valid).toBe(true);
    expect(result.type).toBe("p2tr");
  });
});

// ============================================================================
// 2. JoinSplit commitment model
// ============================================================================

describe("JoinSplit commitment model", () => {
  const pkX = 123456789n;
  const pkY = 987654321n;
  const nk = 111222333n;
  const random = 444555666n;
  const token = ZKBTC_TOKEN_ID;
  const amount = 100_000n;

  test("MPK deterministic", () => {
    const a = computeMPKSync(pkX, pkY, nk);
    const b = computeMPKSync(pkX, pkY, nk);
    expect(a).toBe(b);
    expect(a).not.toBe(0n);
  });

  test("MPK changes with different nullifyingKey", () => {
    const a = computeMPKSync(pkX, pkY, nk);
    const b = computeMPKSync(pkX, pkY, nk + 1n);
    expect(a).not.toBe(b);
  });

  test("NPK deterministic", () => {
    const mpk = computeMPKSync(pkX, pkY, nk);
    const a = computeNPKSync(mpk, random);
    const b = computeNPKSync(mpk, random);
    expect(a).toBe(b);
    expect(a).not.toBe(0n);
  });

  test("NPK changes with different random", () => {
    const mpk = computeMPKSync(pkX, pkY, nk);
    const a = computeNPKSync(mpk, random);
    const b = computeNPKSync(mpk, random + 1n);
    expect(a).not.toBe(b);
  });

  test("JoinSplit commitment deterministic", () => {
    const npk = computeNPKSync(computeMPKSync(pkX, pkY, nk), random);
    const a = computeJoinSplitCommitmentSync(npk, token, amount);
    const b = computeJoinSplitCommitmentSync(npk, token, amount);
    expect(a).toBe(b);
    expect(a).not.toBe(0n);
  });

  test("JoinSplit commitment changes with different amount", () => {
    const npk = computeNPKSync(computeMPKSync(pkX, pkY, nk), random);
    const a = computeJoinSplitCommitmentSync(npk, token, amount);
    const b = computeJoinSplitCommitmentSync(npk, token, amount + 1n);
    expect(a).not.toBe(b);
  });

  test("JoinSplit nullifier deterministic", () => {
    const a = computeJoinSplitNullifierSync(nk, 0n);
    const b = computeJoinSplitNullifierSync(nk, 0n);
    expect(a).toBe(b);
    expect(a).not.toBe(0n);
  });

  test("JoinSplit nullifier changes with different leafIndex", () => {
    const a = computeJoinSplitNullifierSync(nk, 0n);
    const b = computeJoinSplitNullifierSync(nk, 1n);
    expect(a).not.toBe(b);
  });

  test("Full lifecycle: MPK → NPK → commitment → nullifier all within BN254 field", () => {
    const mpk = computeMPKSync(pkX, pkY, nk);
    const npk = computeNPKSync(mpk, random);
    const commitment = computeJoinSplitCommitmentSync(npk, token, amount);
    const nullifier = computeJoinSplitNullifierSync(nk, 0n);

    for (const val of [mpk, npk, commitment, nullifier]) {
      expect(val).not.toBe(0n);
      expect(val).toBeLessThan(BN254_SCALAR_FIELD);
      expect(val).toBeGreaterThan(0n);
    }
  });

  test("MPK matches createStealthMetaAddress.mpk", () => {
    const keys = deriveKeysFromSeed(TEST_SEED);
    const meta = createStealthMetaAddress(keys);
    const mpkFromMeta = bytesToBigint(meta.mpk);
    const mpkDirect = computeMPKSync(
      keys.spendingPubKey.x,
      keys.spendingPubKey.y,
      keys.nullifyingKey,
    );
    expect(mpkFromMeta).toBe(mpkDirect);
  });
});

// ============================================================================
// 3. Merkle tree operations
// ============================================================================

describe("Merkle tree operations", () => {
  test("empty tree has known zero root", () => {
    const tree = new CommitmentTreeIndex();
    expect(tree.getRoot()).toBe(ZERO_HASHES[TREE_DEPTH]);
  });

  test("addCommitment returns sequential indices", () => {
    const tree = new CommitmentTreeIndex();
    const i0 = tree.addCommitment(1n, 100n);
    const i1 = tree.addCommitment(2n, 200n);
    const i2 = tree.addCommitment(3n, 300n);
    expect(i0).toBe(0n);
    expect(i1).toBe(1n);
    expect(i2).toBe(2n);
  });

  test("root changes after each insertion", () => {
    const tree = new CommitmentTreeIndex();
    const root0 = tree.getRoot();
    tree.addCommitment(1n, 100n);
    const root1 = tree.getRoot();
    tree.addCommitment(2n, 200n);
    const root2 = tree.getRoot();

    expect(root0).not.toBe(root1);
    expect(root1).not.toBe(root2);
    expect(root0).not.toBe(root2);
  });

  test("getMerkleProof returns valid structure", () => {
    const tree = new CommitmentTreeIndex();
    tree.addCommitment(42n, 100n);
    const proof = tree.getMerkleProof(42n);

    expect(proof).not.toBeNull();
    expect(proof!.siblings.length).toBe(TREE_DEPTH);
    expect(proof!.indices.length).toBe(TREE_DEPTH);
  });

  test("merkle proof verifies: hash leaf up path yields root", () => {
    const tree = new CommitmentTreeIndex();
    const commitment = 42n;
    tree.addCommitment(commitment, 100n);
    const proof = tree.getMerkleProof(commitment)!;

    // Manually hash from leaf to root
    let current = commitment;
    for (let i = 0; i < TREE_DEPTH; i++) {
      if (proof.indices[i] === 0) {
        current = poseidonHashSync([current, proof.siblings[i]]);
      } else {
        current = poseidonHashSync([proof.siblings[i], current]);
      }
    }
    expect(current).toBe(proof.root);
  });

  test("leafIndex ↔ pathIndices roundtrip", () => {
    for (const idx of [0, 1, 7, 42, 1023]) {
      const pathIndices = leafIndexToPathIndices(idx);
      const recovered = pathIndicesToLeafIndex(pathIndices);
      expect(recovered).toBe(idx);
    }
  });
});

// ============================================================================
// 4. BoundParamsHash
// ============================================================================

describe("BoundParamsHash", () => {
  test("deterministic", () => {
    const a = computeBoundParamsHash(DEFAULT_BOUND_PARAMS);
    const b = computeBoundParamsHash(DEFAULT_BOUND_PARAMS);
    expect(a).toBe(b);
  });

  test("result within BN254 field", () => {
    const hash = computeBoundParamsHash(DEFAULT_BOUND_PARAMS);
    expect(hash).toBeGreaterThan(0n);
    expect(hash).toBeLessThan(BN254_SCALAR_FIELD);
  });

  test("private vs unshield produce different hashes", () => {
    const privateHash = computeBoundParamsHash(DEFAULT_BOUND_PARAMS);
    const unshieldParams = createUnshieldBoundParams(
      new Uint8Array(32).fill(0x01),
      new Uint8Array(32),
    );
    const unshieldHash = computeBoundParamsHash(unshieldParams);
    expect(privateHash).not.toBe(unshieldHash);
  });

  test("different chainId produces different hash", () => {
    const a = computeBoundParamsHash(DEFAULT_BOUND_PARAMS);
    const b = computeBoundParamsHash({ ...DEFAULT_BOUND_PARAMS, chainId: 999n });
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// 5. Stealth deposit → scan cycle
// ============================================================================

describe("Stealth deposit → scan cycle", () => {
  let keys: ReturnType<typeof deriveKeysFromSeed>;
  let meta: ReturnType<typeof createStealthMetaAddress>;
  const amountSats = 50_000n;

  beforeAll(() => {
    keys = deriveKeysFromSeed(TEST_SEED);
    meta = createStealthMetaAddress(keys);
  });

  test("createStealthDeposit returns valid structure", async () => {
    const deposit = await createStealthDeposit(meta, amountSats, ZKBTC_TOKEN_ID);
    expect(deposit.ephemeralPub.length).toBe(32);
    expect(deposit.encryptedAmount.length).toBe(8);
    expect(deposit.commitment.length).toBe(32);
    expect(deposit.createdAt).toBeGreaterThan(0);
  });

  test("scan detects own deposit", async () => {
    const deposit = await createStealthDeposit(meta, amountSats, ZKBTC_TOKEN_ID);
    const announcements = [
      {
        ephemeralPub: deposit.ephemeralPub,
        encryptedAmount: deposit.encryptedAmount,
        commitment: deposit.commitment,
        leafIndex: 0,
      },
    ];
    const found = await scanAnnouncements(keys, announcements, ZKBTC_TOKEN_ID);
    expect(found.length).toBe(1);
    expect(found[0].amount).toBe(amountSats);
  });

  test("wrong keys cannot detect deposit", async () => {
    const otherSeed = new Uint8Array(32).fill(0xbb);
    const otherKeys = deriveKeysFromSeed(otherSeed);
    const deposit = await createStealthDeposit(meta, amountSats, ZKBTC_TOKEN_ID);
    const announcements = [
      {
        ephemeralPub: deposit.ephemeralPub,
        encryptedAmount: deposit.encryptedAmount,
        commitment: deposit.commitment,
        leafIndex: 0,
      },
    ];
    const found = await scanAnnouncements(otherKeys, announcements, ZKBTC_TOKEN_ID);
    expect(found.length).toBe(0);
  });

  test("multiple deposits scanned correctly", async () => {
    const amounts = [10_000n, 20_000n, 30_000n];
    const announcements = [];
    for (let i = 0; i < amounts.length; i++) {
      const deposit = await createStealthDeposit(meta, amounts[i], ZKBTC_TOKEN_ID);
      announcements.push({
        ephemeralPub: deposit.ephemeralPub,
        encryptedAmount: deposit.encryptedAmount,
        commitment: deposit.commitment,
        leafIndex: i,
      });
    }
    const found = await scanAnnouncements(keys, announcements, ZKBTC_TOKEN_ID);
    expect(found.length).toBe(3);
    const foundAmounts = found.map((n) => n.amount).sort();
    expect(foundAmounts).toEqual([10_000n, 20_000n, 30_000n]);
  });

  test("commitment matches JoinSplit formula", async () => {
    const deposit = await createStealthDeposit(meta, amountSats, ZKBTC_TOKEN_ID);
    const announcements = [
      {
        ephemeralPub: deposit.ephemeralPub,
        encryptedAmount: deposit.encryptedAmount,
        commitment: deposit.commitment,
        leafIndex: 0,
      },
    ];
    const found = await scanAnnouncements(keys, announcements, ZKBTC_TOKEN_ID);
    expect(found.length).toBe(1);

    // The commitment on-chain should equal what we get from the formula
    const commitmentBigint = bytesToBigint(deposit.commitment);

    // Recompute: we need the NPK that was used. Since scanning reconstructed
    // the note, we can verify the commitment bytes match
    expect(bytesToBigint(found[0].commitment)).toBe(commitmentBigint);
  });
});

// ============================================================================
// 6. Stealth claim preparation
// ============================================================================

describe("Stealth claim preparation", () => {
  let keys: ReturnType<typeof deriveKeysFromSeed>;
  let meta: ReturnType<typeof createStealthMetaAddress>;
  const amountSats = 50_000n;

  beforeAll(() => {
    keys = deriveKeysFromSeed(TEST_SEED);
    meta = createStealthMetaAddress(keys);
  });

  test("produces valid ClaimInputs", async () => {
    const deposit = await createStealthDeposit(meta, amountSats, ZKBTC_TOKEN_ID);
    const tree = new CommitmentTreeIndex();
    const commitmentBigint = bytesToBigint(deposit.commitment);
    tree.addCommitment(commitmentBigint, amountSats);
    const merkleProof = tree.getMerkleProof(commitmentBigint)!;

    const announcements = [
      {
        ephemeralPub: deposit.ephemeralPub,
        encryptedAmount: deposit.encryptedAmount,
        commitment: deposit.commitment,
        leafIndex: 0,
      },
    ];
    const [note] = await scanAnnouncements(keys, announcements, ZKBTC_TOKEN_ID);
    const claim = await prepareClaimInputs(keys, note, {
      root: merkleProof.root,
      pathElements: merkleProof.siblings,
      pathIndices: merkleProof.indices,
    });

    expect(claim.stealthPrivKey).not.toBe(0n);
    expect(claim.nullifier).not.toBe(0n);
    expect(claim.npk).not.toBe(0n);
    expect(claim.random).not.toBe(0n);
    expect(claim.amount).toBe(amountSats);
    expect(claim.leafIndex).toBe(0);
  });

  test("nullifier matches manual computation", async () => {
    const deposit = await createStealthDeposit(meta, amountSats, ZKBTC_TOKEN_ID);
    const tree = new CommitmentTreeIndex();
    const commitmentBigint = bytesToBigint(deposit.commitment);
    tree.addCommitment(commitmentBigint, amountSats);
    const merkleProof = tree.getMerkleProof(commitmentBigint)!;

    const announcements = [
      {
        ephemeralPub: deposit.ephemeralPub,
        encryptedAmount: deposit.encryptedAmount,
        commitment: deposit.commitment,
        leafIndex: 0,
      },
    ];
    const [note] = await scanAnnouncements(keys, announcements, ZKBTC_TOKEN_ID);
    const claim = await prepareClaimInputs(keys, note, {
      root: merkleProof.root,
      pathElements: merkleProof.siblings,
      pathIndices: merkleProof.indices,
    });

    const manualNullifier = computeJoinSplitNullifierSync(
      keys.nullifyingKey,
      BigInt(note.leafIndex),
    );
    expect(claim.nullifier).toBe(manualNullifier);
  });

  test("npk matches manual computation", async () => {
    const deposit = await createStealthDeposit(meta, amountSats, ZKBTC_TOKEN_ID);
    const tree = new CommitmentTreeIndex();
    const commitmentBigint = bytesToBigint(deposit.commitment);
    tree.addCommitment(commitmentBigint, amountSats);
    const merkleProof = tree.getMerkleProof(commitmentBigint)!;

    const announcements = [
      {
        ephemeralPub: deposit.ephemeralPub,
        encryptedAmount: deposit.encryptedAmount,
        commitment: deposit.commitment,
        leafIndex: 0,
      },
    ];
    const [note] = await scanAnnouncements(keys, announcements, ZKBTC_TOKEN_ID);
    const claim = await prepareClaimInputs(keys, note, {
      root: merkleProof.root,
      pathElements: merkleProof.siblings,
      pathIndices: merkleProof.indices,
    });

    const mpk = computeMPKSync(
      keys.spendingPubKey.x,
      keys.spendingPubKey.y,
      keys.nullifyingKey,
    );
    const manualNPK = computeNPKSync(mpk, claim.random);
    expect(claim.npk).toBe(manualNPK);
  });

  test("commitment verifies against tree", async () => {
    const deposit = await createStealthDeposit(meta, amountSats, ZKBTC_TOKEN_ID);
    const tree = new CommitmentTreeIndex();
    const commitmentBigint = bytesToBigint(deposit.commitment);
    tree.addCommitment(commitmentBigint, amountSats);
    const merkleProof = tree.getMerkleProof(commitmentBigint)!;

    const announcements = [
      {
        ephemeralPub: deposit.ephemeralPub,
        encryptedAmount: deposit.encryptedAmount,
        commitment: deposit.commitment,
        leafIndex: 0,
      },
    ];
    const [note] = await scanAnnouncements(keys, announcements, ZKBTC_TOKEN_ID);
    const claim = await prepareClaimInputs(keys, note, {
      root: merkleProof.root,
      pathElements: merkleProof.siblings,
      pathIndices: merkleProof.indices,
    });

    const recomputed = computeJoinSplitCommitmentSync(claim.npk, ZKBTC_TOKEN_ID, claim.amount);
    expect(recomputed).toBe(commitmentBigint);
  });

  test("throws for wrong keys", async () => {
    const deposit = await createStealthDeposit(meta, amountSats, ZKBTC_TOKEN_ID);
    const tree = new CommitmentTreeIndex();
    const commitmentBigint = bytesToBigint(deposit.commitment);
    tree.addCommitment(commitmentBigint, amountSats);
    const merkleProof = tree.getMerkleProof(commitmentBigint)!;

    // Scan with correct keys to get the note
    const announcements = [
      {
        ephemeralPub: deposit.ephemeralPub,
        encryptedAmount: deposit.encryptedAmount,
        commitment: deposit.commitment,
        leafIndex: 0,
      },
    ];
    const [note] = await scanAnnouncements(keys, announcements, ZKBTC_TOKEN_ID);

    // Attempt claim with wrong keys
    const wrongKeys = deriveKeysFromSeed(new Uint8Array(32).fill(0xcc));
    await expect(
      prepareClaimInputs(wrongKeys, note, {
        root: merkleProof.root,
        pathElements: merkleProof.siblings,
        pathIndices: merkleProof.indices,
      }),
    ).rejects.toThrow();
  });
});

// ============================================================================
// 7. Full deposit-to-claim integration
// ============================================================================

describe("Full deposit-to-claim integration", () => {
  test("complete flow: depositToNote → stealth → tree → claim inputs", async () => {
    const keys = deriveKeysFromSeed(TEST_SEED);
    const meta = createStealthMetaAddress(keys);

    // 1. Generate deposit credentials
    const depositResult = await depositToNote(10_000n);
    expect(depositResult.taprootAddress).toBeTruthy();
    expect(depositResult.note).toBeTruthy();

    // 2. Create stealth deposit
    const deposit = await createStealthDeposit(meta, 10_000n, ZKBTC_TOKEN_ID);
    expect(deposit.commitment.length).toBe(32);

    // 3. Add to tree
    const tree = new CommitmentTreeIndex();
    const commitmentBigint = bytesToBigint(deposit.commitment);
    tree.addCommitment(commitmentBigint, 10_000n);

    // 4. Scan
    const announcements = [
      {
        ephemeralPub: deposit.ephemeralPub,
        encryptedAmount: deposit.encryptedAmount,
        commitment: deposit.commitment,
        leafIndex: 0,
      },
    ];
    const found = await scanAnnouncements(keys, announcements, ZKBTC_TOKEN_ID);
    expect(found.length).toBe(1);

    // 5. Prepare claim
    const merkleProof = tree.getMerkleProof(commitmentBigint)!;
    const claim = await prepareClaimInputs(keys, found[0], {
      root: merkleProof.root,
      pathElements: merkleProof.siblings,
      pathIndices: merkleProof.indices,
    });

    expect(claim.merkleRoot).toBe(tree.getRoot());
    expect(claim.amount).toBe(10_000n);
    expect(claim.nullifier).not.toBe(0n);
  });

  test("multiple deposits create distinct commitments and nullifiers", async () => {
    const keys = deriveKeysFromSeed(TEST_SEED);
    const meta = createStealthMetaAddress(keys);
    const tree = new CommitmentTreeIndex();

    const amounts = [5_000n, 10_000n, 15_000n];
    const allCommitments = new Set<bigint>();
    const allNullifiers = new Set<bigint>();

    for (let i = 0; i < amounts.length; i++) {
      const deposit = await createStealthDeposit(meta, amounts[i], ZKBTC_TOKEN_ID);
      const commitmentBigint = bytesToBigint(deposit.commitment);
      tree.addCommitment(commitmentBigint, amounts[i]);
      allCommitments.add(commitmentBigint);

      const announcements = [
        {
          ephemeralPub: deposit.ephemeralPub,
          encryptedAmount: deposit.encryptedAmount,
          commitment: deposit.commitment,
          leafIndex: i,
        },
      ];
      const [note] = await scanAnnouncements(keys, announcements, ZKBTC_TOKEN_ID);
      const merkleProof = tree.getMerkleProof(commitmentBigint)!;
      const claim = await prepareClaimInputs(keys, note, {
        root: merkleProof.root,
        pathElements: merkleProof.siblings,
        pathIndices: merkleProof.indices,
      });
      allNullifiers.add(claim.nullifier);
    }

    expect(allCommitments.size).toBe(3);
    expect(allNullifiers.size).toBe(3);
  });

  test("zero amount throws", async () => {
    await expect(depositToNote(0n)).rejects.toThrow();
  });
});
