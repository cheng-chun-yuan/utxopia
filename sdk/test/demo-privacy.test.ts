/**
 * Demo Privacy Tests
 *
 * Comprehensive demo tests exercising the full deposit flow, OP_RETURN commitment
 * embedding, and Railgun-style privacy patterns (shielded transfers, note splitting,
 * view-only scanning, HD recovery).
 *
 * All tests are pure unit tests — no network, no validator, no compiled circuits.
 */

import { describe, test, expect, beforeAll } from "bun:test";

// Poseidon
import {
  initPoseidon,
  computeMPKSync,
  computeNPKSync,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
} from "../src/poseidon";

// Keys
import {
  deriveKeysFromSeed,
  createStealthMetaAddress,
  encodeStealthMetaAddress,
} from "../src/keys";

// Stealth
import {
  createStealthDeposit,
  scanAnnouncements,
  scanAnnouncementsViewOnly,
  exportViewOnlyKeys,
  prepareClaimInputs,
} from "../src/stealth";

// ZKBTC_TOKEN_ID was removed — use a test constant matching old value
const ZKBTC_TOKEN_ID = 0x7a627463n;

// Taproot
import {
  deriveTaprootAddress,
  createOpReturnScript,
  parseOpReturnCommitment,
  buildMockBtcTransaction,
  createP2TRScriptPubkey,
} from "../src/taproot";

// Commitment tree
import {
  CommitmentTreeIndex,
  TREE_DEPTH,
} from "../src/commitment-tree";

// Bound params
import { computeBoundParamsHash, DEFAULT_BOUND_PARAMS } from "../src/bound-params";

// Note / HD recovery
import {
  deriveNote,
  deriveMasterKey,
  deriveNoteFromMaster,
  computeNoteCommitment,
} from "../src/note";

// Crypto helpers
import { bigintToBytes, bytesToBigint, bytesToHex } from "../src/crypto";

// ============================================================================
// Setup
// ============================================================================

const DEMO_SEED_ALICE = new Uint8Array(32).fill(0xa1);
const DEMO_SEED_BOB = new Uint8Array(32).fill(0xb2);
const DEMO_SEED_CAROL = new Uint8Array(32).fill(0xc3);

function log(label: string, value: unknown): void {
  console.log(`  [demo] ${label}: ${typeof value === "bigint" ? "0x" + value.toString(16).slice(0, 16) + "..." : value}`);
}

beforeAll(async () => {
  await initPoseidon();
});

// ============================================================================
// Block 1: Full Deposit Flow Walkthrough
// ============================================================================

describe("Demo: Full deposit flow walkthrough", () => {
  test("step-by-step deposit lifecycle with console output", async () => {
    // 1. Generate keys
    const aliceKeys = deriveKeysFromSeed(DEMO_SEED_ALICE);
    log("Alice spending pub X", aliceKeys.spendingPubKey.x);
    log("Alice viewing pub", bytesToHex(aliceKeys.viewingPubKey).slice(0, 32) + "...");
    expect(aliceKeys.spendingPubKey.x).toBeGreaterThan(0n);
    expect(aliceKeys.viewingPubKey.length).toBe(32);

    // 2. Compute MPK
    const mpk = computeMPKSync(
      aliceKeys.spendingPubKey.x,
      aliceKeys.spendingPubKey.y,
      aliceKeys.nullifyingKey,
    );
    log("Alice MPK", mpk);
    expect(mpk).toBeGreaterThan(0n);

    // 3. Create stealth meta-address
    const aliceMeta = createStealthMetaAddress(aliceKeys);
    const encodedMeta = encodeStealthMetaAddress(aliceMeta);
    log("Stealth meta-address", encodedMeta.slice(0, 32) + "...");
    expect(aliceMeta.spendingPubKey.length).toBe(32);
    expect(aliceMeta.viewingPubKey.length).toBe(32);
    expect(aliceMeta.mpk.length).toBe(32);

    // 4. Derive taproot deposit address
    const commitment32 = bigintToBytes(mpk);
    const taproot = deriveTaprootAddress(commitment32, "testnet");
    log("Taproot address", taproot.address);
    expect(taproot.address).toStartWith("tb1p");
    expect(taproot.outputKey.length).toBe(32);

    // 5. Create stealth deposit (simulates sender creating output for Alice)
    const depositAmount = 100_000n;
    const deposit = await createStealthDeposit(aliceMeta, depositAmount, ZKBTC_TOKEN_ID);
    log("Ephemeral pub", bytesToHex(deposit.ephemeralPub).slice(0, 32) + "...");
    log("Commitment", bytesToHex(deposit.commitment).slice(0, 32) + "...");
    expect(deposit.ephemeralPub.length).toBe(32);
    expect(deposit.encryptedAmount.length).toBe(8);
    expect(deposit.commitment.length).toBe(32);

    // 6. Scan announcements (Alice detects her deposit)
    const announcements = [{
      ephemeralPub: deposit.ephemeralPub,
      encryptedAmount: deposit.encryptedAmount,
      commitment: deposit.commitment,
      leafIndex: 0,
    }];
    const found = await scanAnnouncements(aliceKeys, announcements, ZKBTC_TOKEN_ID);
    expect(found).toHaveLength(1);
    expect(found[0].amount).toBe(depositAmount);
    log("Scanned amount", found[0].amount.toString() + " sats");

    // 7. Insert into merkle tree
    const tree = new CommitmentTreeIndex();
    const commitmentBigint = bytesToBigint(deposit.commitment);
    const leafIndex = tree.addCommitment(commitmentBigint, depositAmount);
    log("Leaf index", leafIndex.toString());
    log("Tree root", tree.getRoot());
    expect(leafIndex).toBe(0n);
    expect(tree.getRoot()).toBeGreaterThan(0n);

    // 8. Prepare claim inputs
    const proof = tree.getMerkleProof(commitmentBigint);
    expect(proof).not.toBeNull();
    const claimInputs = await prepareClaimInputs(aliceKeys, found[0], {
      root: proof!.root,
      pathElements: proof!.siblings,
      pathIndices: proof!.indices,
    });
    log("Nullifier", claimInputs.nullifier);
    log("NPK", claimInputs.npk);
    expect(claimInputs.nullifier).toBeGreaterThan(0n);
    expect(claimInputs.npk).toBeGreaterThan(0n);
    expect(claimInputs.amount).toBe(depositAmount);

    // 9. Verify commitment formula matches
    const expectedCommitment = computeJoinSplitCommitmentSync(
      claimInputs.npk,
      ZKBTC_TOKEN_ID,
      depositAmount,
    );
    expect(expectedCommitment).toBe(commitmentBigint);
  });
});

// ============================================================================
// Block 2: OP_RETURN Commitment Embedding
// ============================================================================

describe("OP_RETURN commitment embedding", () => {
  test("createOpReturnScript produces correct 34-byte script", () => {
    const commitment = new Uint8Array(32).fill(0xab);
    const script = createOpReturnScript(commitment);

    expect(script.length).toBe(34);
    expect(script[0]).toBe(0x6a); // OP_RETURN
    expect(script[1]).toBe(0x20); // Push 32
    expect(script.slice(2)).toEqual(commitment);
  });

  test("parseOpReturnCommitment roundtrip", () => {
    const commitment = new Uint8Array(32);
    for (let i = 0; i < 32; i++) commitment[i] = i;

    const script = createOpReturnScript(commitment);
    const parsed = parseOpReturnCommitment(script);

    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(commitment);
  });

  test("rejects non-OP_RETURN scripts (returns null for P2TR)", () => {
    const outputKey = new Uint8Array(32).fill(0x42);
    const p2trScript = createP2TRScriptPubkey(outputKey);

    const result = parseOpReturnCommitment(p2trScript);
    expect(result).toBeNull();
  });

  test("buildMockBtcTransaction includes OP_RETURN with commitment", () => {
    const commitment = new Uint8Array(32).fill(0xcd);
    const outputKey = new Uint8Array(32).fill(0x42);
    const amountSats = 50_000n;

    const rawTx = buildMockBtcTransaction(amountSats, outputKey, commitment);
    expect(rawTx.length).toBeGreaterThan(0);

    // Verify tx contains the commitment bytes
    const txHex = bytesToHex(rawTx);
    const commitmentHex = bytesToHex(commitment);
    expect(txHex).toContain(commitmentHex);
  });

  test("mock tx includes P2TR output with correct amount (LE)", () => {
    const commitment = new Uint8Array(32).fill(0xab);
    const outputKey = new Uint8Array(32).fill(0x99);
    const amountSats = 10_000n;

    const rawTx = buildMockBtcTransaction(amountSats, outputKey, commitment);

    // Version = 0x02000000 at offset 0
    expect(rawTx[0]).toBe(0x02);

    // Find P2TR output: after input section
    // version(4) + inputCount(1) + input(45) + outputCount(1) = offset 51
    // Output 0: amount(8) + scriptLen(1) + script(34)
    const amountOffset = 51;
    const view = new DataView(rawTx.buffer, rawTx.byteOffset + amountOffset, 8);
    expect(view.getBigUint64(0, true)).toBe(amountSats);

    // P2TR script starts at offset 51+8+1 = 60
    expect(rawTx[60]).toBe(0x51); // OP_1
    expect(rawTx[61]).toBe(0x20); // Push 32
  });

  test("full flow: derive address -> commitment -> embed OP_RETURN -> extract -> verify match", async () => {
    const aliceKeys = deriveKeysFromSeed(DEMO_SEED_ALICE);
    const aliceMeta = createStealthMetaAddress(aliceKeys);
    const depositAmount = 75_000n;

    // Create stealth deposit (generates commitment)
    const deposit = await createStealthDeposit(aliceMeta, depositAmount, ZKBTC_TOKEN_ID);

    // Derive taproot address from commitment
    const taproot = deriveTaprootAddress(deposit.commitment, "testnet");

    // Build mock BTC tx with OP_RETURN embedding
    const rawTx = buildMockBtcTransaction(
      depositAmount,
      taproot.outputKey,
      deposit.commitment,
    );

    // Extract commitment from OP_RETURN in tx
    // Output 1 script starts at: version(4) + inputCount(1) + input(45) + outputCount(1)
    //   + out0(8+1+34) + out1_amount(8) + out1_scriptLen(1) = 103
    const scriptOffset = 51 + 43 + 9; // = 103
    const opReturnScript = rawTx.slice(scriptOffset, scriptOffset + 34);
    const extractedCommitment = parseOpReturnCommitment(opReturnScript);

    expect(extractedCommitment).not.toBeNull();
    expect(extractedCommitment).toEqual(deposit.commitment);
  });
});

// ============================================================================
// Block 3: Railgun-style Shielded Transfer (2->2)
// ============================================================================

describe("Railgun-style shielded transfer (2->2)", () => {
  test("Alice sends to Bob with change back to self", async () => {
    const aliceKeys = deriveKeysFromSeed(DEMO_SEED_ALICE);
    const bobKeys = deriveKeysFromSeed(DEMO_SEED_BOB);
    const aliceMeta = createStealthMetaAddress(aliceKeys);
    const bobMeta = createStealthMetaAddress(bobKeys);

    const initialAmount = 100_000n;
    const sendAmount = 60_000n;
    const changeAmount = 40_000n;

    // Alice's initial deposit
    const aliceDeposit = await createStealthDeposit(aliceMeta, initialAmount, ZKBTC_TOKEN_ID);
    const aliceAnnouncements = [{
      ephemeralPub: aliceDeposit.ephemeralPub,
      encryptedAmount: aliceDeposit.encryptedAmount,
      commitment: aliceDeposit.commitment,
      leafIndex: 0,
    }];
    const aliceNotes = await scanAnnouncements(aliceKeys, aliceAnnouncements, ZKBTC_TOKEN_ID);
    expect(aliceNotes).toHaveLength(1);
    expect(aliceNotes[0].amount).toBe(initialAmount);

    // Create output for Bob
    const bobOutput = await createStealthDeposit(bobMeta, sendAmount, ZKBTC_TOKEN_ID);
    // Create change output for Alice
    const aliceChange = await createStealthDeposit(aliceMeta, changeAmount, ZKBTC_TOKEN_ID);

    // Both commitments valid and distinct
    expect(bobOutput.commitment.length).toBe(32);
    expect(aliceChange.commitment.length).toBe(32);
    expect(bytesToHex(bobOutput.commitment)).not.toBe(bytesToHex(aliceChange.commitment));

    // Bob scans: finds incoming note with correct amount
    const bobAnnouncements = [{
      ephemeralPub: bobOutput.ephemeralPub,
      encryptedAmount: bobOutput.encryptedAmount,
      commitment: bobOutput.commitment,
      leafIndex: 1,
    }];
    const bobNotes = await scanAnnouncements(bobKeys, bobAnnouncements, ZKBTC_TOKEN_ID);
    expect(bobNotes).toHaveLength(1);
    expect(bobNotes[0].amount).toBe(sendAmount);

    // Alice scans: finds change note with correct amount
    const changeAnnouncements = [{
      ephemeralPub: aliceChange.ephemeralPub,
      encryptedAmount: aliceChange.encryptedAmount,
      commitment: aliceChange.commitment,
      leafIndex: 2,
    }];
    const aliceChangeNotes = await scanAnnouncements(aliceKeys, changeAnnouncements, ZKBTC_TOKEN_ID);
    expect(aliceChangeNotes).toHaveLength(1);
    expect(aliceChangeNotes[0].amount).toBe(changeAmount);

    // Nullifier from spent input is deterministic (double-spend prevention)
    const nullifier1 = computeJoinSplitNullifierSync(aliceKeys.nullifyingKey, 0n);
    const nullifier2 = computeJoinSplitNullifierSync(aliceKeys.nullifyingKey, 0n);
    expect(nullifier1).toBe(nullifier2);
    expect(nullifier1).toBeGreaterThan(0n);

    // Bound params hash binds to chain
    const boundHash = computeBoundParamsHash(DEFAULT_BOUND_PARAMS);
    expect(boundHash).toBeGreaterThan(0n);
  });
});

// ============================================================================
// Block 4: Railgun-style Note Splitting (1->3)
// ============================================================================

describe("Railgun-style note splitting (1->3)", () => {
  test("split 100k sats into 50k + 30k + 20k", async () => {
    const aliceKeys = deriveKeysFromSeed(DEMO_SEED_ALICE);
    const aliceMeta = createStealthMetaAddress(aliceKeys);

    const amounts = [50_000n, 30_000n, 20_000n];

    // Create 3 outputs to self
    const outputs = await Promise.all(
      amounts.map((amt) => createStealthDeposit(aliceMeta, amt, ZKBTC_TOKEN_ID)),
    );

    // All 3 commitments distinct
    const commitmentHexes = outputs.map((o) => bytesToHex(o.commitment));
    const uniqueCommitments = new Set(commitmentHexes);
    expect(uniqueCommitments.size).toBe(3);

    // All 3 scannable by owner with correct amounts
    for (let i = 0; i < 3; i++) {
      const ann = [{
        ephemeralPub: outputs[i].ephemeralPub,
        encryptedAmount: outputs[i].encryptedAmount,
        commitment: outputs[i].commitment,
        leafIndex: i,
      }];
      const notes = await scanAnnouncements(aliceKeys, ann, ZKBTC_TOKEN_ID);
      expect(notes).toHaveLength(1);
      expect(notes[0].amount).toBe(amounts[i]);
    }

    // Original note nullifier computed
    const originalNullifier = computeJoinSplitNullifierSync(aliceKeys.nullifyingKey, 0n);
    expect(originalNullifier).toBeGreaterThan(0n);
  });
});

// ============================================================================
// Block 5: Railgun-style View-Only Scanning
// ============================================================================

describe("Railgun-style view-only scanning", () => {
  test("export view-only keys — has viewing priv but NOT spending priv", () => {
    const aliceKeys = deriveKeysFromSeed(DEMO_SEED_ALICE);
    const viewOnly = exportViewOnlyKeys(aliceKeys);

    // Has viewing private key
    expect(viewOnly.viewingPrivKey.length).toBe(32);
    // Has spending public key (not private)
    expect(viewOnly.spendingPubKey.x).toBeGreaterThan(0n);
    // Has nullifying key (needed for MPK)
    expect(viewOnly.nullifyingKey).toBeGreaterThan(0n);
    // No spending private key property
    expect("spendingPrivKey" in viewOnly).toBe(false);
  });

  test("view-only scan detects deposits with correct amounts", async () => {
    const aliceKeys = deriveKeysFromSeed(DEMO_SEED_ALICE);
    const aliceMeta = createStealthMetaAddress(aliceKeys);
    const viewOnly = exportViewOnlyKeys(aliceKeys);

    const deposit = await createStealthDeposit(aliceMeta, 42_000n, ZKBTC_TOKEN_ID);
    const announcements = [{
      ephemeralPub: deposit.ephemeralPub,
      encryptedAmount: deposit.encryptedAmount,
      commitment: deposit.commitment,
      leafIndex: 0,
    }];

    const found = await scanAnnouncementsViewOnly(viewOnly, announcements, ZKBTC_TOKEN_ID);
    expect(found).toHaveLength(1);
    expect(found[0].amount).toBe(42_000n);
    expect(found[0].leafIndex).toBe(0);
  });

  test("view-only keys cannot prepare claim (needs spending key)", async () => {
    const aliceKeys = deriveKeysFromSeed(DEMO_SEED_ALICE);
    const aliceMeta = createStealthMetaAddress(aliceKeys);
    const viewOnly = exportViewOnlyKeys(aliceKeys);

    const deposit = await createStealthDeposit(aliceMeta, 10_000n, ZKBTC_TOKEN_ID);

    // View-only scan works
    const voAnnouncements = [{
      ephemeralPub: deposit.ephemeralPub,
      encryptedAmount: deposit.encryptedAmount,
      commitment: deposit.commitment,
      leafIndex: 0,
    }];
    const voNotes = await scanAnnouncementsViewOnly(viewOnly, voAnnouncements, ZKBTC_TOKEN_ID);
    expect(voNotes).toHaveLength(1);

    // Full scan with spending keys works and can prepare claim
    const fullNotes = await scanAnnouncements(aliceKeys, voAnnouncements, ZKBTC_TOKEN_ID);
    expect(fullNotes).toHaveLength(1);

    // prepareClaimInputs requires full keys (spending key)
    const tree = new CommitmentTreeIndex();
    tree.addCommitment(bytesToBigint(deposit.commitment), 10_000n);
    const proof = tree.getMerkleProof(bytesToBigint(deposit.commitment))!;

    // This should succeed with full keys
    const claim = await prepareClaimInputs(aliceKeys, fullNotes[0], {
      root: proof.root,
      pathElements: proof.siblings,
      pathIndices: proof.indices,
    });
    expect(claim.stealthPrivKey).toBeGreaterThan(0n);

    // View-only keys don't have spendingPrivKey — can't prepare claim
    // (the type system prevents this, but we verify the key separation)
    expect(viewOnly).not.toHaveProperty("spendingPrivKey");
  });

  test("multiple deposits scanned view-only", async () => {
    const aliceKeys = deriveKeysFromSeed(DEMO_SEED_ALICE);
    const aliceMeta = createStealthMetaAddress(aliceKeys);
    const viewOnly = exportViewOnlyKeys(aliceKeys);

    const amounts = [10_000n, 25_000n, 50_000n];
    const deposits = await Promise.all(
      amounts.map((amt) => createStealthDeposit(aliceMeta, amt, ZKBTC_TOKEN_ID)),
    );

    const announcements = deposits.map((d, i) => ({
      ephemeralPub: d.ephemeralPub,
      encryptedAmount: d.encryptedAmount,
      commitment: d.commitment,
      leafIndex: i,
    }));

    const found = await scanAnnouncementsViewOnly(viewOnly, announcements, ZKBTC_TOKEN_ID);
    expect(found).toHaveLength(3);

    const foundAmounts = found.map((n) => n.amount).sort();
    expect(foundAmounts).toEqual([10_000n, 25_000n, 50_000n]);
  });
});

// ============================================================================
// Block 6: Railgun-style HD Note Recovery
// ============================================================================

describe("Railgun-style HD note recovery", () => {
  test("deterministic: same seed+index -> same note", () => {
    const note1 = deriveNote("albertgogogo", 0, 100_000n);
    const note2 = deriveNote("albertgogogo", 0, 100_000n);

    expect(note1.nullifier).toBe(note2.nullifier);
    expect(note1.secret).toBe(note2.secret);
    expect(note1.amount).toBe(note2.amount);
  });

  test("different indices -> different notes", () => {
    const note0 = deriveNote("albertgogogo", 0, 100_000n);
    const note1 = deriveNote("albertgogogo", 1, 100_000n);

    expect(note0.nullifier).not.toBe(note1.nullifier);
    expect(note0.secret).not.toBe(note1.secret);
  });

  test("master key recovery: deriveMasterKey -> deriveNoteFromMaster x N", () => {
    const master = deriveMasterKey("albertgogogo");
    expect(master.length).toBe(32);

    const note0 = deriveNoteFromMaster(master, 0, 100_000n);
    const note1 = deriveNoteFromMaster(master, 1, 50_000n);
    const note2 = deriveNoteFromMaster(master, 2, 25_000n);

    // Should match direct derivation
    const direct0 = deriveNote("albertgogogo", 0, 100_000n);
    const direct1 = deriveNote("albertgogogo", 1, 50_000n);
    const direct2 = deriveNote("albertgogogo", 2, 25_000n);

    expect(note0.nullifier).toBe(direct0.nullifier);
    expect(note1.nullifier).toBe(direct1.nullifier);
    expect(note2.nullifier).toBe(direct2.nullifier);
  });

  test("recovered notes have valid commitments via computeNoteCommitment", () => {
    const note = deriveNote("albertgogogo", 0, 100_000n);
    const withCommitment = computeNoteCommitment(note);

    expect(withCommitment.commitment).toBeGreaterThan(0n);
    expect(withCommitment.commitmentBytes.length).toBe(32);

    // Commitment is deterministic
    const again = computeNoteCommitment(deriveNote("albertgogogo", 0, 100_000n));
    expect(again.commitment).toBe(withCommitment.commitment);
  });
});

// ============================================================================
// Block 7: Multi-Party Privacy Scenario
// ============================================================================

describe("Demo: multi-party privacy scenario", () => {
  test("Alice deposits -> transfers to Bob -> Bob splits -> Carol view-only scans", async () => {
    const aliceKeys = deriveKeysFromSeed(DEMO_SEED_ALICE);
    const bobKeys = deriveKeysFromSeed(DEMO_SEED_BOB);
    const carolKeys = deriveKeysFromSeed(DEMO_SEED_CAROL);

    const aliceMeta = createStealthMetaAddress(aliceKeys);
    const bobMeta = createStealthMetaAddress(bobKeys);
    const carolMeta = createStealthMetaAddress(carolKeys);

    // Step 1: Alice deposits 100k sats
    const aliceDeposit = await createStealthDeposit(aliceMeta, 100_000n, ZKBTC_TOKEN_ID);
    const aliceAnn = [{
      ephemeralPub: aliceDeposit.ephemeralPub,
      encryptedAmount: aliceDeposit.encryptedAmount,
      commitment: aliceDeposit.commitment,
      leafIndex: 0,
    }];
    const aliceNotes = await scanAnnouncements(aliceKeys, aliceAnn, ZKBTC_TOKEN_ID);
    expect(aliceNotes).toHaveLength(1);

    // Step 2: Alice sends 70k to Bob, 30k change to self
    const bobOutput = await createStealthDeposit(bobMeta, 70_000n, ZKBTC_TOKEN_ID);
    const aliceChangeOutput = await createStealthDeposit(aliceMeta, 30_000n, ZKBTC_TOKEN_ID);

    // Bob scans and finds his 70k
    const bobAnn = [{
      ephemeralPub: bobOutput.ephemeralPub,
      encryptedAmount: bobOutput.encryptedAmount,
      commitment: bobOutput.commitment,
      leafIndex: 1,
    }];
    const bobNotes = await scanAnnouncements(bobKeys, bobAnn, ZKBTC_TOKEN_ID);
    expect(bobNotes).toHaveLength(1);
    expect(bobNotes[0].amount).toBe(70_000n);

    // Alice scans change
    const aliceChangeAnn = [{
      ephemeralPub: aliceChangeOutput.ephemeralPub,
      encryptedAmount: aliceChangeOutput.encryptedAmount,
      commitment: aliceChangeOutput.commitment,
      leafIndex: 2,
    }];
    const aliceChangeNotes = await scanAnnouncements(aliceKeys, aliceChangeAnn, ZKBTC_TOKEN_ID);
    expect(aliceChangeNotes).toHaveLength(1);
    expect(aliceChangeNotes[0].amount).toBe(30_000n);

    // Step 3: Bob splits his 70k into 3 outputs to self: 40k + 20k + 10k
    const bobSplitAmounts = [40_000n, 20_000n, 10_000n];
    const bobSplitOutputs = await Promise.all(
      bobSplitAmounts.map((amt) => createStealthDeposit(bobMeta, amt, ZKBTC_TOKEN_ID)),
    );

    for (let i = 0; i < 3; i++) {
      const ann = [{
        ephemeralPub: bobSplitOutputs[i].ephemeralPub,
        encryptedAmount: bobSplitOutputs[i].encryptedAmount,
        commitment: bobSplitOutputs[i].commitment,
        leafIndex: 3 + i,
      }];
      const notes = await scanAnnouncements(bobKeys, ann, ZKBTC_TOKEN_ID);
      expect(notes).toHaveLength(1);
      expect(notes[0].amount).toBe(bobSplitAmounts[i]);
    }

    // Step 4: Carol uses view-only keys to scan — sees nothing (not her notes)
    const carolViewOnly = exportViewOnlyKeys(carolKeys);
    const allAnnouncements = [
      ...aliceAnn,
      ...bobAnn,
      ...aliceChangeAnn,
      ...bobSplitOutputs.map((o, i) => ({
        ephemeralPub: o.ephemeralPub,
        encryptedAmount: o.encryptedAmount,
        commitment: o.commitment,
        leafIndex: 3 + i,
      })),
    ];
    const carolFound = await scanAnnouncementsViewOnly(carolViewOnly, allAnnouncements, ZKBTC_TOKEN_ID);
    expect(carolFound).toHaveLength(0);

    // Each party sees only their own notes
    const aliceAll = await scanAnnouncements(aliceKeys, allAnnouncements, ZKBTC_TOKEN_ID);
    const bobAll = await scanAnnouncements(bobKeys, allAnnouncements, ZKBTC_TOKEN_ID);

    // Alice sees her deposit + change = 2 notes
    expect(aliceAll).toHaveLength(2);
    expect(aliceAll.map((n) => n.amount).sort((a, b) => Number(a - b))).toEqual([30_000n, 100_000n]);

    // Bob sees his received + 3 splits = 4 notes
    expect(bobAll).toHaveLength(4);
    expect(bobAll.map((n) => n.amount).sort((a, b) => Number(a - b))).toEqual([10_000n, 20_000n, 40_000n, 70_000n]);

    // Nullifiers unique across all operations
    const nullifiers = new Set<bigint>();
    for (let i = 0; i < 6; i++) {
      // Alice's nullifier for leaf 0, Bob's for leaves 1, 3, 4, 5
      const nk = i < 2 ? aliceKeys.nullifyingKey : bobKeys.nullifyingKey;
      nullifiers.add(computeJoinSplitNullifierSync(nk, BigInt(i)));
    }
    expect(nullifiers.size).toBe(6);
  });
});
