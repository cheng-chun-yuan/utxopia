/**
 * Cross-layer instruction builder tests
 *
 * Verifies that the 4 SDK instruction builders produce byte layouts
 * exactly matching what the on-chain Rust code parses.
 *
 * Tested builders:
 * 1. buildTransactInstructionData (disc 13)
 * 2. buildUnshieldInstructionData (disc 14)
 * 3. buildRedemptionRequestInstructionData (disc 16)
 * 4. buildCompleteRedemptionInstructionData (disc 17)
 *
 * For each builder we verify:
 * - Discriminator byte
 * - Total data length
 * - Field offsets match Rust parsing
 * - Account count and order
 * - Edge cases (min/max inputs, empty optional fields)
 *
 * Reference Rust files:
 * - contracts/programs/utxopia/src/instructions/transact.rs
 * - contracts/programs/utxopia/src/instructions/unshield.rs
 * - contracts/programs/utxopia/src/instructions/request_redemption.rs
 * - contracts/programs/utxopia/src/instructions/complete_redemption.rs
 */

import { describe, it, expect } from "bun:test";
import { address, AccountRole } from "@solana/kit";

import {
  buildTransactInstructionData,
  buildTransactInstruction,
  buildUnshieldInstructionData,
  buildUnshieldInstruction,
  buildRedemptionRequestInstructionData,
  buildRedemptionRequestInstruction,
  buildCompleteRedemptionInstructionData,
  buildCompleteRedemptionInstruction,
} from "../../src/instructions";

// =============================================================================
// Contract constants (from Rust source of truth)
// =============================================================================

/** From contracts/programs/utxopia/src/constants.rs */
const MAX_SAFE_JOINSPLIT_SIZE = 10;
const MAX_BTC_SCRIPT_LEN = 34;
const GROTH16_PROOF_SIZE = 256;
const STEALTH_DATA_PER_OUTPUT = 72; // ephemeral_pub(32) + encrypted_amount(8) + encrypted_token_id(32)

// Instruction discriminators from contracts/programs/utxopia/src/lib.rs
const DISC_TRANSACT = 13;
const DISC_UNSHIELD = 14;
const DISC_REQUEST_REDEMPTION = 16;
const DISC_COMPLETE_REDEMPTION = 17;

// =============================================================================
// Helpers
// =============================================================================

/** Create a deterministic Uint8Array filled with a pattern */
function filledBytes(len: number, fill: number): Uint8Array {
  return new Uint8Array(len).fill(fill);
}

/** Create a fake proof (256 bytes) */
function fakeProof(): Uint8Array {
  const proof = new Uint8Array(GROTH16_PROOF_SIZE);
  for (let i = 0; i < GROTH16_PROOF_SIZE; i++) proof[i] = i & 0xff;
  return proof;
}

/** Create fake stealth data per output (72 bytes: ephemeral_pub(32) + encrypted_amount(8) + encrypted_token_id(32)) */
function fakeStealth(idx: number): Uint8Array {
  const sd = new Uint8Array(STEALTH_DATA_PER_OUTPUT);
  sd.set(filledBytes(32, 0xe0 + idx), 0);  // ephemeral_pub
  sd.set(filledBytes(8, 0xa0 + idx), 32);   // encrypted_amount
  sd.set(filledBytes(32, 0xb0 + idx), 40);  // encrypted_token_id
  return sd;
}

/** Fake Solana address for tests */
function fakeAddress(label: string): ReturnType<typeof address> {
  return address("11111111111111111111111111111111");
}

// =============================================================================
// TRANSACT (disc 13) — contracts/programs/utxopia/src/instructions/transact.rs
// =============================================================================

describe("Cross-layer: buildTransactInstructionData (disc=13)", () => {
  /**
   * Rust layout (data received AFTER disc is stripped by entrypoint):
   * [0]       n_inputs:          u8
   * [1]       n_outputs:         u8
   * [2]       n_public_outputs:  u8  (0 for transact)
   * [3]       proof_source:      u8  (0=inline)
   * [4..260]  proof:             [u8; 256]
   * [260..292] merkle_root:      [u8; 32]
   * [292..324] bound_params_hash: [u8; 32]
   * [324..]   nullifiers:        [[u8; 32]; n_inputs]
   * [..]      commitments_out:   [[u8; 32]; n_outputs]
   * [..]      stealth_data:      [72 bytes] x n_outputs
   */

  describe("discriminator", () => {
    it("first byte is 13", () => {
      const data = buildTransactInstructionData({
        nInputs: 1,
        nOutputs: 1,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03)],
        commitmentsOut: [filledBytes(32, 0x04)],
        stealthData: [fakeStealth(0)],
      });
      expect(data[0]).toBe(DISC_TRANSACT);
    });
  });

  describe("total data length", () => {
    it("1x1: disc(1) + header(4) + proof(256) + root(32) + bph(32) + null(1*32) + comm(1*32) + stealth(1*72) = 461", () => {
      const expected = 1 + 4 + 256 + 32 + 32 + 32 + 32 + 72;
      expect(expected).toBe(461);
      const data = buildTransactInstructionData({
        nInputs: 1, nOutputs: 1,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03)],
        commitmentsOut: [filledBytes(32, 0x04)],
        stealthData: [fakeStealth(0)],
      });
      expect(data.length).toBe(expected);
    });

    it("2x2: disc(1) + header(4) + proof(256) + root(32) + bph(32) + null(2*32) + comm(2*32) + stealth(2*72) = 597", () => {
      const expected = 1 + 4 + 256 + 32 + 32 + 64 + 64 + 144;
      expect(expected).toBe(597);
      const data = buildTransactInstructionData({
        nInputs: 2, nOutputs: 2,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03), filledBytes(32, 0x13)],
        commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14)],
        stealthData: [fakeStealth(0), fakeStealth(1)],
      });
      expect(data.length).toBe(expected);
    });

    it("generic NxM formula: 1 + 4 + 256 + 32 + 32 + N*32 + M*32 + M*72", () => {
      for (const [n, m] of [[1, 2], [2, 1], [3, 3], [1, 9], [5, 5]]) {
        const expected = 1 + 4 + 256 + 32 + 32 + n * 32 + m * 32 + m * 72;
        const data = buildTransactInstructionData({
          nInputs: n, nOutputs: m,
          proofBytes: fakeProof(),
          merkleRoot: filledBytes(32, 0x01),
          boundParamsHash: filledBytes(32, 0x02),
          nullifiers: Array.from({ length: n }, (_, i) => filledBytes(32, 0x10 + i)),
          commitmentsOut: Array.from({ length: m }, (_, i) => filledBytes(32, 0x20 + i)),
          stealthData: Array.from({ length: m }, (_, i) => fakeStealth(i)),
        });
        expect(data.length).toBe(expected);
      }
    });
  });

  describe("field offsets match Rust parsing", () => {
    it("n_inputs, n_outputs, n_public_outputs, proof_source use the common 4-byte header", () => {
      const data = buildTransactInstructionData({
        nInputs: 2, nOutputs: 3,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03), filledBytes(32, 0x13)],
        commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14), filledBytes(32, 0x24)],
        stealthData: [fakeStealth(0), fakeStealth(1), fakeStealth(2)],
      });
      // After disc strip, Rust reads data[0]=n_inputs, data[1]=n_outputs,
      // data[2]=n_public_outputs, data[3]=proof_source.
      const contractData = data.slice(1);
      expect(contractData[0]).toBe(2); // n_inputs
      expect(contractData[1]).toBe(3); // n_outputs
      expect(contractData[2]).toBe(0); // n_public_outputs = 0 for private transfer
      expect(contractData[3]).toBe(0); // proof_source = 0 (inline)
    });

    it("proof at offset 4 (contract offset), 256 bytes", () => {
      const proof = fakeProof();
      const data = buildTransactInstructionData({
        nInputs: 1, nOutputs: 1,
        proofBytes: proof,
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03)],
        commitmentsOut: [filledBytes(32, 0x04)],
        stealthData: [fakeStealth(0)],
      });
      const contractData = data.slice(1); // strip disc
      const parsedProof = contractData.slice(4, 4 + 256);
      expect(parsedProof).toEqual(proof);
    });

    it("merkle_root at offset 260 (contract), bound_params_hash at 292", () => {
      const root = filledBytes(32, 0xaa);
      const bph = filledBytes(32, 0xbb);
      const data = buildTransactInstructionData({
        nInputs: 1, nOutputs: 1,
        proofBytes: fakeProof(),
        merkleRoot: root,
        boundParamsHash: bph,
        nullifiers: [filledBytes(32, 0x03)],
        commitmentsOut: [filledBytes(32, 0x04)],
        stealthData: [fakeStealth(0)],
      });
      const contractData = data.slice(1);
      expect(contractData.slice(260, 292)).toEqual(root);
      expect(contractData.slice(292, 324)).toEqual(bph);
    });

    it("nullifiers start at 324 (contract), then commitments, then stealth_data", () => {
      const null0 = filledBytes(32, 0xc0);
      const null1 = filledBytes(32, 0xc1);
      const comm0 = filledBytes(32, 0xd0);
      const comm1 = filledBytes(32, 0xd1);
      const st0 = fakeStealth(0);
      const st1 = fakeStealth(1);

      const data = buildTransactInstructionData({
        nInputs: 2, nOutputs: 2,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [null0, null1],
        commitmentsOut: [comm0, comm1],
        stealthData: [st0, st1],
      });
      const cd = data.slice(1);

      expect(cd.slice(324, 356)).toEqual(null0);
      expect(cd.slice(356, 388)).toEqual(null1);

      expect(cd.slice(388, 420)).toEqual(comm0);
      expect(cd.slice(420, 452)).toEqual(comm1);

      expect(cd.slice(452, 452 + 72)).toEqual(st0.slice(0, 72));
      expect(cd.slice(452 + 72, 452 + 144)).toEqual(st1.slice(0, 72));
    });
  });

  describe("account count and order", () => {
    it("1x1 = 5 fixed + 1 nullifier record = 6 accounts", () => {
      const ix = buildTransactInstruction({
        nInputs: 1, nOutputs: 1,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03)],
        commitmentsOut: [filledBytes(32, 0x04)],
        stealthData: [fakeStealth(0)],
        accounts: {
          poolState: fakeAddress("pool"),
          commitmentTree: fakeAddress("tree"),
          vkRegistry: fakeAddress("vk"),
          user: fakeAddress("user"),
          nullifierRecords: [fakeAddress("nr0")],
        },
      });
      expect(ix.accounts.length).toBe(6);
    });

    it("2x2 = 5 fixed + 2 nullifier records = 7 accounts", () => {
      const ix = buildTransactInstruction({
        nInputs: 2, nOutputs: 2,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03), filledBytes(32, 0x13)],
        commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14)],
        stealthData: [fakeStealth(0), fakeStealth(1)],
        accounts: {
          poolState: fakeAddress("pool"),
          commitmentTree: fakeAddress("tree"),
          vkRegistry: fakeAddress("vk"),
          user: fakeAddress("user"),
          nullifierRecords: [fakeAddress("nr0"), fakeAddress("nr1")],
        },
      });
      expect(ix.accounts.length).toBe(7);
    });

    it("account order: pool_state(w), commitment_tree(w), vk_registry(r), user(ws), system(r), nullifiers(w)", () => {
      const ix = buildTransactInstruction({
        nInputs: 1, nOutputs: 1,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03)],
        commitmentsOut: [filledBytes(32, 0x04)],
        stealthData: [fakeStealth(0)],
        accounts: {
          poolState: fakeAddress("pool"),
          commitmentTree: fakeAddress("tree"),
          vkRegistry: fakeAddress("vk"),
          user: fakeAddress("user"),
          nullifierRecords: [fakeAddress("nr0")],
        },
      });
      expect(ix.accounts[0].role).toBe(AccountRole.WRITABLE);           // pool_state
      expect(ix.accounts[1].role).toBe(AccountRole.WRITABLE);           // commitment_tree
      expect(ix.accounts[2].role).toBe(AccountRole.READONLY);           // vk_registry
      expect(ix.accounts[3].role).toBe(AccountRole.WRITABLE_SIGNER);   // user
      expect(ix.accounts[4].role).toBe(AccountRole.READONLY);           // system_program
      expect(ix.accounts[5].role).toBe(AccountRole.WRITABLE);           // nullifier_record
    });
  });

  describe("edge cases", () => {
    it("rejects proof != 256 bytes", () => {
      expect(() =>
        buildTransactInstructionData({
          nInputs: 1, nOutputs: 1,
          proofBytes: new Uint8Array(128),
          merkleRoot: filledBytes(32, 0x01),
          boundParamsHash: filledBytes(32, 0x02),
          nullifiers: [filledBytes(32, 0x03)],
          commitmentsOut: [filledBytes(32, 0x04)],
          stealthData: [fakeStealth(0)],
        })
      ).toThrow("256-byte proof");
    });

    it("rejects mismatched nullifier count", () => {
      expect(() =>
        buildTransactInstructionData({
          nInputs: 2, nOutputs: 1,
          proofBytes: fakeProof(),
          merkleRoot: filledBytes(32, 0x01),
          boundParamsHash: filledBytes(32, 0x02),
          nullifiers: [filledBytes(32, 0x03)], // only 1, expected 2
          commitmentsOut: [filledBytes(32, 0x04)],
          stealthData: [fakeStealth(0)],
        })
      ).toThrow("nullifiers");
    });

    it("rejects mismatched commitment count", () => {
      expect(() =>
        buildTransactInstructionData({
          nInputs: 1, nOutputs: 2,
          proofBytes: fakeProof(),
          merkleRoot: filledBytes(32, 0x01),
          boundParamsHash: filledBytes(32, 0x02),
          nullifiers: [filledBytes(32, 0x03)],
          commitmentsOut: [filledBytes(32, 0x04)], // only 1, expected 2
          stealthData: [fakeStealth(0), fakeStealth(1)],
        })
      ).toThrow("commitments");
    });

    it("rejects mismatched stealth data count", () => {
      expect(() =>
        buildTransactInstructionData({
          nInputs: 1, nOutputs: 2,
          proofBytes: fakeProof(),
          merkleRoot: filledBytes(32, 0x01),
          boundParamsHash: filledBytes(32, 0x02),
          nullifiers: [filledBytes(32, 0x03)],
          commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14)],
          stealthData: [fakeStealth(0)], // only 1, expected 2
        })
      ).toThrow("stealth");
    });

    it("max variant 5x5 produces correct length", () => {
      const n = 5, m = 5;
      const expected = 1 + 4 + 256 + 32 + 32 + n * 32 + m * 32 + m * 72;
      const data = buildTransactInstructionData({
        nInputs: n, nOutputs: m,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: Array.from({ length: n }, (_, i) => filledBytes(32, 0x10 + i)),
        commitmentsOut: Array.from({ length: m }, (_, i) => filledBytes(32, 0x20 + i)),
        stealthData: Array.from({ length: m }, (_, i) => fakeStealth(i)),
      });
      expect(data.length).toBe(expected);
    });
  });
});

// =============================================================================
// UNSHIELD (disc 14) — contracts/programs/utxopia/src/instructions/unshield.rs
// =============================================================================

describe("Cross-layer: buildUnshieldInstructionData (disc=14)", () => {
  /**
   * Rust layout (data received AFTER disc stripped):
   * [0]       n_inputs:          u8
   * [1]       n_outputs:         u8  (includes burn output as last)
   * [2]       n_public_outputs:  u8
   * [3]       proof_source:      u8
   * [4..260]  proof:             [u8; 256]
   * [260..292] merkle_root:      [u8; 32]
   * [292..324] bound_params_hash: [u8; 32]
   * [324..]   nullifiers:        [[u8; 32]; n_inputs]
   * [..]      commitments_out:   [[u8; 32]; n_outputs]  (last = burn)
   * [..]      stealth_data:      [72 bytes] x (n_outputs - 1)
   * [..]      unshield_amount:   u64 LE
   */

  describe("discriminator", () => {
    it("first byte is 14", () => {
      const data = buildUnshieldInstructionData({
        nInputs: 2, nOutputs: 2,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03), filledBytes(32, 0x13)],
        commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14)],
        stealthData: [fakeStealth(0)], // n_outputs - 1 = 1
        unshieldAmounts: [50000n],
      });
      expect(data[0]).toBe(DISC_UNSHIELD);
    });
  });

  describe("total data length", () => {
    it("2x2: disc(1) + header(4) + proof(256) + root(32) + bph(32) + null(2*32) + comm(2*32) + stealth(1*72) + amount(8) = 533", () => {
      const n = 2, m = 2;
      const nTreeOutputs = m - 1;
      const expected = 1 + 4 + 256 + 32 + 32 + n * 32 + m * 32 + nTreeOutputs * 72 + 8;
      expect(expected).toBe(533);
      const data = buildUnshieldInstructionData({
        nInputs: n, nOutputs: m,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03), filledBytes(32, 0x13)],
        commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14)],
        stealthData: [fakeStealth(0)],
        unshieldAmounts: [50000n],
      });
      expect(data.length).toBe(expected);
    });

    it("1x1 (only burn output, 0 tree outputs): disc(1) + header(4) + proof(256) + root(32) + bph(32) + null(32) + comm(32) + stealth(0) + amount(8) = 397", () => {
      const expected = 1 + 4 + 256 + 32 + 32 + 32 + 32 + 0 + 8;
      expect(expected).toBe(397);
      const data = buildUnshieldInstructionData({
        nInputs: 1, nOutputs: 1,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03)],
        commitmentsOut: [filledBytes(32, 0x04)],
        stealthData: [], // n_outputs - 1 = 0
        unshieldAmounts: [10000n],
      });
      expect(data.length).toBe(expected);
    });

    it("generic NxM formula: 1 + 4 + 256 + 32 + 32 + N*32 + M*32 + (M-1)*72 + 8", () => {
      for (const [n, m] of [[1, 2], [2, 1], [3, 3], [2, 4]]) {
        const nTree = m - 1;
        const expected = 1 + 4 + 256 + 32 + 32 + n * 32 + m * 32 + nTree * 72 + 8;
        const data = buildUnshieldInstructionData({
          nInputs: n, nOutputs: m,
          proofBytes: fakeProof(),
          merkleRoot: filledBytes(32, 0x01),
          boundParamsHash: filledBytes(32, 0x02),
          nullifiers: Array.from({ length: n }, (_, i) => filledBytes(32, 0x10 + i)),
          commitmentsOut: Array.from({ length: m }, (_, i) => filledBytes(32, 0x20 + i)),
          stealthData: Array.from({ length: nTree }, (_, i) => fakeStealth(i)),
          unshieldAmounts: [99999n],
        });
        expect(data.length).toBe(expected);
      }
    });
  });

  describe("field offsets match Rust parsing", () => {
    it("n_inputs, n_outputs, n_public_outputs, proof_source use the common 4-byte header", () => {
      const data = buildUnshieldInstructionData({
        nInputs: 2, nOutputs: 3,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03), filledBytes(32, 0x13)],
        commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14), filledBytes(32, 0x24)],
        stealthData: [fakeStealth(0), fakeStealth(1)], // n_outputs - 1 = 2
        unshieldAmounts: [12345n],
      });
      const cd = data.slice(1); // strip disc
      expect(cd[0]).toBe(2); // n_inputs
      expect(cd[1]).toBe(3); // n_outputs
      expect(cd[2]).toBe(1); // n_public_outputs defaults to one public output
      expect(cd[3]).toBe(0); // proof_source = 0 (inline)
    });

    it("proof at offset 4 (contract), 256 bytes", () => {
      const proof = fakeProof();
      const data = buildUnshieldInstructionData({
        nInputs: 1, nOutputs: 2,
        proofBytes: proof,
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03)],
        commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14)],
        stealthData: [fakeStealth(0)],
        unshieldAmounts: [50000n],
      });
      const cd = data.slice(1);
      expect(cd.slice(4, 4 + 256)).toEqual(proof);
    });

    it("merkle_root at 260, bound_params_hash at 292 (contract offsets)", () => {
      const root = filledBytes(32, 0xaa);
      const bph = filledBytes(32, 0xbb);
      const data = buildUnshieldInstructionData({
        nInputs: 1, nOutputs: 2,
        proofBytes: fakeProof(),
        merkleRoot: root,
        boundParamsHash: bph,
        nullifiers: [filledBytes(32, 0x03)],
        commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14)],
        stealthData: [fakeStealth(0)],
        unshieldAmounts: [50000n],
      });
      const cd = data.slice(1);
      expect(cd.slice(260, 292)).toEqual(root);
      expect(cd.slice(292, 324)).toEqual(bph);
    });

    it("nullifiers at 324, commitments follow, then stealth, then unshield_amount", () => {
      const null0 = filledBytes(32, 0xc0);
      const comm0 = filledBytes(32, 0xd0);
      const comm1 = filledBytes(32, 0xd1); // burn commitment
      const st0 = fakeStealth(0);
      const amount = 77777n;

      const data = buildUnshieldInstructionData({
        nInputs: 1, nOutputs: 2,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [null0],
        commitmentsOut: [comm0, comm1],
        stealthData: [st0],
        unshieldAmounts: [amount],
      });
      const cd = data.slice(1);

      expect(cd.slice(324, 356)).toEqual(null0);

      expect(cd.slice(356, 388)).toEqual(comm0);
      expect(cd.slice(388, 420)).toEqual(comm1);

      expect(cd.slice(420, 420 + 72)).toEqual(st0.slice(0, 72));

      const amountOffset = 420 + 72;
      const parsedAmount = new DataView(cd.buffer, cd.byteOffset).getBigUint64(amountOffset, true);
      expect(parsedAmount).toBe(amount);
    });
  });

  describe("account count and order", () => {
    it("2x2 = 9 fixed + 2 nullifier records = 11 accounts", () => {
      const ix = buildUnshieldInstruction({
        nInputs: 2, nOutputs: 2,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03), filledBytes(32, 0x13)],
        commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14)],
        stealthData: [fakeStealth(0)],
        unshieldAmounts: [50000n],
        accounts: {
          poolState: fakeAddress("pool"),
          commitmentTree: fakeAddress("tree"),
          vkRegistry: fakeAddress("vk"),
          user: fakeAddress("user"),
          tokenConfig: fakeAddress("tc"),
          vault: fakeAddress("vault"),
          recipientTokenAccounts: [fakeAddress("uta")],
          nullifierRecords: [fakeAddress("nr0"), fakeAddress("nr1")],
        },
      });
      expect(ix.accounts.length).toBe(11);
    });

    it("account order matches Rust: pool(r), tree(w), vk(r), user(ws), sys(r), tc(w), vault(w), token(r), recipients(w), nullifiers(w)", () => {
      const ix = buildUnshieldInstruction({
        nInputs: 1, nOutputs: 2,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03)],
        commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14)],
        stealthData: [fakeStealth(0)],
        unshieldAmounts: [50000n],
        accounts: {
          poolState: fakeAddress("pool"),
          commitmentTree: fakeAddress("tree"),
          vkRegistry: fakeAddress("vk"),
          user: fakeAddress("user"),
          tokenConfig: fakeAddress("tc"),
          vault: fakeAddress("vault"),
          recipientTokenAccounts: [fakeAddress("uta")],
          nullifierRecords: [fakeAddress("nr0")],
        },
      });
      expect(ix.accounts[0].role).toBe(AccountRole.READONLY);           // pool_state (read in unshield)
      expect(ix.accounts[1].role).toBe(AccountRole.WRITABLE);           // commitment_tree
      expect(ix.accounts[2].role).toBe(AccountRole.READONLY);           // vk_registry
      expect(ix.accounts[3].role).toBe(AccountRole.WRITABLE_SIGNER);   // user
      expect(ix.accounts[4].role).toBe(AccountRole.READONLY);           // system_program
      expect(ix.accounts[5].role).toBe(AccountRole.WRITABLE);           // token_config
      expect(ix.accounts[6].role).toBe(AccountRole.WRITABLE);           // vault
      expect(ix.accounts[7].role).toBe(AccountRole.READONLY);           // token_program
      expect(ix.accounts[8].role).toBe(AccountRole.WRITABLE);           // recipient token account
      expect(ix.accounts[9].role).toBe(AccountRole.WRITABLE);           // nullifier_record
    });
  });

  describe("key difference from transact", () => {
    it("transact and unshield share the same common proof header", () => {
      const transactData = buildTransactInstructionData({
        nInputs: 1, nOutputs: 1,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03)],
        commitmentsOut: [filledBytes(32, 0x04)],
        stealthData: [fakeStealth(0)],
      });
      const unshieldData = buildUnshieldInstructionData({
        nInputs: 1, nOutputs: 1,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03)],
        commitmentsOut: [filledBytes(32, 0x04)],
        stealthData: [], // 0 tree outputs for 1x1 unshield
        unshieldAmounts: [50000n],
      });

      const tcd = transactData.slice(1);
      const ucd = unshieldData.slice(1);

      expect(tcd[2]).toBe(0); // transact has no public outputs
      expect(ucd[2]).toBe(1); // unshield defaults to one public output
      expect(tcd[3]).toBe(0); // proof_source
      expect(ucd[3]).toBe(0); // proof_source
      expect(tcd.slice(4, 4 + 256)).toEqual(ucd.slice(4, 4 + 256));
    });

    it("stealth_data has (n_outputs-1) entries, not n_outputs", () => {
      // For 2x3 unshield: 2 tree outputs (not 3), so 2 stealth entries
      const data = buildUnshieldInstructionData({
        nInputs: 2, nOutputs: 3,
        proofBytes: fakeProof(),
        merkleRoot: filledBytes(32, 0x01),
        boundParamsHash: filledBytes(32, 0x02),
        nullifiers: [filledBytes(32, 0x03), filledBytes(32, 0x13)],
        commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14), filledBytes(32, 0x24)],
        stealthData: [fakeStealth(0), fakeStealth(1)], // 3-1=2
        unshieldAmounts: [50000n],
      });
      const nTree = 3 - 1;
      const expected = 1 + 4 + 256 + 32 + 32 + 2 * 32 + 3 * 32 + nTree * 72 + 8;
      expect(data.length).toBe(expected);
    });
  });

  describe("edge cases", () => {
    it("rejects proof != 256 bytes", () => {
      expect(() =>
        buildUnshieldInstructionData({
          nInputs: 1, nOutputs: 1,
          proofBytes: new Uint8Array(200),
          merkleRoot: filledBytes(32, 0x01),
          boundParamsHash: filledBytes(32, 0x02),
          nullifiers: [filledBytes(32, 0x03)],
          commitmentsOut: [filledBytes(32, 0x04)],
          stealthData: [],
          unshieldAmounts: [50000n],
        })
      ).toThrow("256-byte proof");
    });

    it("rejects wrong stealth count (should be n_outputs - 1)", () => {
      expect(() =>
        buildUnshieldInstructionData({
          nInputs: 1, nOutputs: 2,
          proofBytes: fakeProof(),
          merkleRoot: filledBytes(32, 0x01),
          boundParamsHash: filledBytes(32, 0x02),
          nullifiers: [filledBytes(32, 0x03)],
          commitmentsOut: [filledBytes(32, 0x04), filledBytes(32, 0x14)],
          stealthData: [fakeStealth(0), fakeStealth(1)], // 2 but expected 1
          unshieldAmounts: [50000n],
        })
      ).toThrow("stealth");
    });
  });
});

// =============================================================================
// REQUEST_REDEMPTION (disc 16) — contracts/programs/utxopia/src/instructions/request_redemption.rs
// =============================================================================

describe("Cross-layer: buildRedemptionRequestInstructionData (disc=16)", () => {
  /**
   * Rust layout (data received AFTER disc stripped):
   * [0..32]     proof_hash:     [u8; 32]
   * [32..64]    merkle_root:    [u8; 32]
   * [64..96]    nullifier_hash: [u8; 32]
   * [96..104]   amount_sats:    u64 LE
   * [104..136]  vk_hash:        [u8; 32]
   * [136]       btc_script_len: u8
   * [137..137+len] btc_script:  variable
   * [137+len..] request_nonce:  u64 LE
   *
   * Minimum: 145 bytes (with btc_script_len=0, nonce=8) but script_len=0 rejected on-chain
   */

  describe("discriminator", () => {
    it("first byte is 16", () => {
      const data = buildRedemptionRequestInstructionData({
        proofHash: filledBytes(32, 0x01),
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: 100000n,
        vkHash: filledBytes(32, 0x04),
        btcScript: filledBytes(22, 0x55), // P2WPKH
        requestNonce: 1n,
      });
      expect(data[0]).toBe(DISC_REQUEST_REDEMPTION);
    });
  });

  describe("total data length", () => {
    it("with 22-byte P2WPKH script: disc(1) + proof_hash(32) + root(32) + nullifier(32) + amount(8) + vk(32) + len(1) + script(22) + nonce(8) = 168", () => {
      const scriptLen = 22;
      const expected = 1 + 32 + 32 + 32 + 8 + 32 + 1 + scriptLen + 8;
      expect(expected).toBe(168);
      const data = buildRedemptionRequestInstructionData({
        proofHash: filledBytes(32, 0x01),
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: 100000n,
        vkHash: filledBytes(32, 0x04),
        btcScript: filledBytes(scriptLen, 0x55),
        requestNonce: 1n,
      });
      expect(data.length).toBe(expected);
    });

    it("with 34-byte P2TR script: disc(1) + 32 + 32 + 32 + 8 + 32 + 1 + 34 + 8 = 180", () => {
      const scriptLen = 34;
      const expected = 1 + 32 + 32 + 32 + 8 + 32 + 1 + scriptLen + 8;
      expect(expected).toBe(180);
      const data = buildRedemptionRequestInstructionData({
        proofHash: filledBytes(32, 0x01),
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: 200000n,
        vkHash: filledBytes(32, 0x04),
        btcScript: filledBytes(scriptLen, 0x66),
        requestNonce: 42n,
      });
      expect(data.length).toBe(expected);
    });

    it("with empty script: disc(1) + 32 + 32 + 32 + 8 + 32 + 1 + 0 + 8 = 146", () => {
      const expected = 1 + 32 + 32 + 32 + 8 + 32 + 1 + 0 + 8;
      expect(expected).toBe(146);
      const data = buildRedemptionRequestInstructionData({
        proofHash: filledBytes(32, 0x01),
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: 100000n,
        vkHash: filledBytes(32, 0x04),
        btcScript: new Uint8Array(0),
        requestNonce: 1n,
      });
      expect(data.length).toBe(expected);
    });
  });

  describe("field offsets match Rust parsing", () => {
    it("proof_hash at 0, merkle_root at 32, nullifier_hash at 64 (contract offsets)", () => {
      const ph = filledBytes(32, 0xaa);
      const mr = filledBytes(32, 0xbb);
      const nh = filledBytes(32, 0xcc);

      const data = buildRedemptionRequestInstructionData({
        proofHash: ph,
        merkleRoot: mr,
        nullifierHash: nh,
        amountSats: 50000n,
        vkHash: filledBytes(32, 0x00),
        btcScript: filledBytes(22, 0x55),
        requestNonce: 1n,
      });
      const cd = data.slice(1); // strip disc

      // Rust: proof_hash.copy_from_slice(&data[0..32])
      expect(cd.slice(0, 32)).toEqual(ph);
      // Rust: merkle_root.copy_from_slice(&data[32..64])
      expect(cd.slice(32, 64)).toEqual(mr);
      // Rust: nullifier_hash.copy_from_slice(&data[64..96])
      expect(cd.slice(64, 96)).toEqual(nh);
    });

    it("amount_sats at 96 as u64 LE", () => {
      const amount = 123456789n;
      const data = buildRedemptionRequestInstructionData({
        proofHash: filledBytes(32, 0x01),
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: amount,
        vkHash: filledBytes(32, 0x04),
        btcScript: filledBytes(22, 0x55),
        requestNonce: 1n,
      });
      const cd = data.slice(1);
      // Rust: u64::from_le_bytes(data[96..104])
      const parsed = new DataView(cd.buffer, cd.byteOffset).getBigUint64(96, true);
      expect(parsed).toBe(amount);
    });

    it("vk_hash at 104, btc_script_len at 136", () => {
      const vk = filledBytes(32, 0xdd);
      const script = filledBytes(22, 0x55);
      const data = buildRedemptionRequestInstructionData({
        proofHash: filledBytes(32, 0x01),
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: 50000n,
        vkHash: vk,
        btcScript: script,
        requestNonce: 1n,
      });
      const cd = data.slice(1);

      // Rust: vk_hash.copy_from_slice(&data[104..136])
      expect(cd.slice(104, 136)).toEqual(vk);
      // Rust: let btc_script_len = data[136]
      expect(cd[136]).toBe(22);
    });

    it("btc_script at 137, request_nonce at 137+script_len", () => {
      const script = new Uint8Array([0x51, 0x20, ...new Array(30).fill(0xab)]);
      expect(script.length).toBe(32);
      const nonce = 9999n;
      const data = buildRedemptionRequestInstructionData({
        proofHash: filledBytes(32, 0x01),
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: 50000n,
        vkHash: filledBytes(32, 0x04),
        btcScript: script,
        requestNonce: nonce,
      });
      const cd = data.slice(1);

      // Rust: btc_script[..btc_script_len].copy_from_slice(&data[137..addr_end])
      expect(cd.slice(137, 137 + 32)).toEqual(script);
      // Rust: u64::from_le_bytes(data[addr_end..addr_end + 8])
      const parsed = new DataView(cd.buffer, cd.byteOffset).getBigUint64(137 + 32, true);
      expect(parsed).toBe(nonce);
    });

    it("Rust minimum size check: data.len() >= 145", () => {
      // 145 = proof_hash(32) + merkle_root(32) + nullifier_hash(32) + amount(8) + vk_hash(32) + btc_script_len(1) + nonce(8)
      // With btc_script_len=0 and nonce=8, that's 32+32+32+8+32+1+8 = 145
      const data = buildRedemptionRequestInstructionData({
        proofHash: filledBytes(32, 0x01),
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: 50000n,
        vkHash: filledBytes(32, 0x04),
        btcScript: new Uint8Array(0),
        requestNonce: 1n,
      });
      const cd = data.slice(1);
      // Must be >= Rust's minimum of 145
      expect(cd.length).toBeGreaterThanOrEqual(145);
    });
  });

  describe("account count and order", () => {
    it("requires exactly 7 accounts", () => {
      const ix = buildRedemptionRequestInstruction({
        proofHash: filledBytes(32, 0x01),
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: 100000n,
        vkHash: filledBytes(32, 0x04),
        btcScript: filledBytes(22, 0x55),
        requestNonce: 1n,
        accounts: {
          poolState: fakeAddress("pool"),
          commitmentTree: fakeAddress("tree"),
          nullifierRecord: fakeAddress("nr"),
          redemptionRequest: fakeAddress("rr"),
          user: fakeAddress("user"),
          tokenConfig: fakeAddress("tc"),
        },
      });
      expect(ix.accounts.length).toBe(7);
    });

    it("account order: pool(w), tree(r), nullifier(w), redemption(w), user(ws), system(r), token_config(w)", () => {
      const ix = buildRedemptionRequestInstruction({
        proofHash: filledBytes(32, 0x01),
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: 100000n,
        vkHash: filledBytes(32, 0x04),
        btcScript: filledBytes(22, 0x55),
        requestNonce: 1n,
        accounts: {
          poolState: fakeAddress("pool"),
          commitmentTree: fakeAddress("tree"),
          nullifierRecord: fakeAddress("nr"),
          redemptionRequest: fakeAddress("rr"),
          user: fakeAddress("user"),
          tokenConfig: fakeAddress("tc"),
        },
      });
      expect(ix.accounts[0].role).toBe(AccountRole.WRITABLE);           // pool_state
      expect(ix.accounts[1].role).toBe(AccountRole.READONLY);           // commitment_tree
      expect(ix.accounts[2].role).toBe(AccountRole.WRITABLE);           // nullifier_record
      expect(ix.accounts[3].role).toBe(AccountRole.WRITABLE);           // redemption_request
      expect(ix.accounts[4].role).toBe(AccountRole.WRITABLE_SIGNER);   // user
      expect(ix.accounts[5].role).toBe(AccountRole.READONLY);           // system_program
      expect(ix.accounts[6].role).toBe(AccountRole.WRITABLE);           // token_config
    });
  });

  describe("edge cases", () => {
    it("rejects btc_script > 34 bytes (MAX_BTC_SCRIPT_LEN)", () => {
      expect(() =>
        buildRedemptionRequestInstructionData({
          proofHash: filledBytes(32, 0x01),
          merkleRoot: filledBytes(32, 0x02),
          nullifierHash: filledBytes(32, 0x03),
          amountSats: 100000n,
          vkHash: filledBytes(32, 0x04),
          btcScript: filledBytes(35, 0x55), // exceeds 34
          requestNonce: 1n,
        })
      ).toThrow("too long");
    });

    it("accepts max script length (34 bytes)", () => {
      const data = buildRedemptionRequestInstructionData({
        proofHash: filledBytes(32, 0x01),
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: 100000n,
        vkHash: filledBytes(32, 0x04),
        btcScript: filledBytes(MAX_BTC_SCRIPT_LEN, 0x55),
        requestNonce: 1n,
      });
      const cd = data.slice(1);
      expect(cd[136]).toBe(MAX_BTC_SCRIPT_LEN);
    });

    it("demo mode: proof_hash=zeros, vk_hash=zeros still builds correctly", () => {
      const data = buildRedemptionRequestInstructionData({
        proofHash: new Uint8Array(32), // all zeros
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: 50000n,
        vkHash: new Uint8Array(32), // all zeros
        btcScript: filledBytes(22, 0x55),
        requestNonce: 1n,
      });
      const cd = data.slice(1);
      // proof_hash should be all zeros
      expect(cd.slice(0, 32)).toEqual(new Uint8Array(32));
      // vk_hash should be all zeros
      expect(cd.slice(104, 136)).toEqual(new Uint8Array(32));
    });

    it("large nonce (u64 max) is correctly LE-encoded", () => {
      const maxNonce = 0xFFFFFFFFFFFFFFFFn;
      const data = buildRedemptionRequestInstructionData({
        proofHash: filledBytes(32, 0x01),
        merkleRoot: filledBytes(32, 0x02),
        nullifierHash: filledBytes(32, 0x03),
        amountSats: 50000n,
        vkHash: filledBytes(32, 0x04),
        btcScript: filledBytes(22, 0x55),
        requestNonce: maxNonce,
      });
      const cd = data.slice(1);
      const nonceOffset = 137 + 22;
      const parsed = new DataView(cd.buffer, cd.byteOffset).getBigUint64(nonceOffset, true);
      expect(parsed).toBe(maxNonce);
    });
  });
});

// =============================================================================
// COMPLETE_REDEMPTION (disc 17) — contracts/programs/utxopia/src/instructions/complete_redemption.rs
// =============================================================================

describe("Cross-layer: buildCompleteRedemptionInstructionData (disc=17)", () => {
  /**
   * Rust layout (data received AFTER disc stripped):
   * [0..32]    btc_txid:          [u8; 32]
   * [32..36]   tx_size:           u32 LE
   * [36]       pool_script_len:   u8
   * [37..37+len] pool_script:     variable (0-34 bytes)
   * [37+len]   consumed_utxo_count: u8
   *
   * MIN_SIZE = 32 + 4 + 1 + 1 = 38 (no pool_script)
   */

  describe("discriminator", () => {
    it("first byte is 17", () => {
      const data = buildCompleteRedemptionInstructionData({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 225,
        poolScript: new Uint8Array(0),
        consumedUtxoCount: 0,
      });
      expect(data[0]).toBe(DISC_COMPLETE_REDEMPTION);
    });
  });

  describe("total data length", () => {
    it("no pool_script: disc(1) + txid(32) + tx_size(4) + len(1) + utxo_count(1) = 39", () => {
      const expected = 1 + 32 + 4 + 1 + 0 + 1;
      expect(expected).toBe(39);
      const data = buildCompleteRedemptionInstructionData({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 225,
        poolScript: new Uint8Array(0),
        consumedUtxoCount: 0,
      });
      expect(data.length).toBe(expected);
    });

    it("with 34-byte P2TR pool_script: disc(1) + txid(32) + tx_size(4) + len(1) + script(34) + utxo_count(1) = 73", () => {
      const expected = 1 + 32 + 4 + 1 + 34 + 1;
      expect(expected).toBe(73);
      const data = buildCompleteRedemptionInstructionData({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 500,
        poolScript: filledBytes(34, 0x77),
        consumedUtxoCount: 2,
      });
      expect(data.length).toBe(expected);
    });
  });

  describe("field offsets match Rust parsing", () => {
    it("btc_txid at 0 (contract offset)", () => {
      const txid = filledBytes(32, 0xbb);
      const data = buildCompleteRedemptionInstructionData({
        btcTxid: txid,
        txSize: 300,
        poolScript: new Uint8Array(0),
        consumedUtxoCount: 0,
      });
      const cd = data.slice(1);
      // Rust: btc_txid.copy_from_slice(&data[0..32])
      expect(cd.slice(0, 32)).toEqual(txid);
    });

    it("tx_size at 32 as u32 LE", () => {
      const txSize = 12345;
      const data = buildCompleteRedemptionInstructionData({
        btcTxid: filledBytes(32, 0xaa),
        txSize,
        poolScript: new Uint8Array(0),
        consumedUtxoCount: 0,
      });
      const cd = data.slice(1);
      // Rust: u32::from_le_bytes(data[32..36])
      const parsed = new DataView(cd.buffer, cd.byteOffset).getUint32(32, true);
      expect(parsed).toBe(txSize);
    });

    it("pool_script_len at 36", () => {
      const data = buildCompleteRedemptionInstructionData({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 225,
        poolScript: filledBytes(22, 0x55),
        consumedUtxoCount: 0,
      });
      const cd = data.slice(1);
      // Rust: let pool_script_len = data[36]
      expect(cd[36]).toBe(22);
    });

    it("pool_script at 37 (variable length), consumed_utxo_count after", () => {
      const script = filledBytes(34, 0x77);
      const data = buildCompleteRedemptionInstructionData({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 225,
        poolScript: script,
        consumedUtxoCount: 3,
      });
      const cd = data.slice(1);

      // Rust: pool_script = &data[37..37+34]
      expect(cd.slice(37, 37 + 34)).toEqual(script);
      // Rust: consumed_utxo_count = data[37+34]
      expect(cd[37 + 34]).toBe(3);
    });

    it("no pool_script: consumed_utxo_count at 37", () => {
      const data = buildCompleteRedemptionInstructionData({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 225,
        poolScript: new Uint8Array(0),
        consumedUtxoCount: 5,
      });
      const cd = data.slice(1);

      expect(cd[36]).toBe(0); // pool_script_len = 0
      // Rust: if pool_script_len == 0, offset stays at 37
      // consumed_utxo_count = data[37] when pool_script_len=0
      expect(cd[37]).toBe(5);
    });

    it("Rust MIN_SIZE check: data.len() >= 38 (after disc)", () => {
      const data = buildCompleteRedemptionInstructionData({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 100,
        poolScript: new Uint8Array(0),
        consumedUtxoCount: 0,
      });
      const cd = data.slice(1);
      // Rust: CompleteRedemptionData::MIN_SIZE = 32 + 4 + 1 + 1 = 38
      expect(cd.length).toBeGreaterThanOrEqual(38);
    });
  });

  describe("account count and order", () => {
    it("base: 14 accounts (no consumed UTXOs)", () => {
      const ix = buildCompleteRedemptionInstruction({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 225,
        poolScript: filledBytes(34, 0x77),
        consumedUtxoCount: 0,
        accounts: {
          poolState: fakeAddress("pool"),
          redemptionRequest: fakeAddress("rr"),
          authority: fakeAddress("auth"),
          rentRecipient: fakeAddress("rent"),
          verifiedTransaction: fakeAddress("vt"),
          lightClient: fakeAddress("lc"),
          txBuffer: fakeAddress("buf"),
          zkbtcMint: fakeAddress("mint"),
          poolVault: fakeAddress("vault"),
          completionReceipt: fakeAddress("cr"),
          poolConfig: fakeAddress("pc"),
          changeUtxo: fakeAddress("change"),
        },
      });
      expect(ix.accounts.length).toBe(14);
    });

    it("with 3 consumed UTXOs: 14 + 3 = 17 accounts", () => {
      const ix = buildCompleteRedemptionInstruction({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 225,
        poolScript: filledBytes(34, 0x77),
        consumedUtxoCount: 3,
        accounts: {
          poolState: fakeAddress("pool"),
          redemptionRequest: fakeAddress("rr"),
          authority: fakeAddress("auth"),
          rentRecipient: fakeAddress("rent"),
          verifiedTransaction: fakeAddress("vt"),
          lightClient: fakeAddress("lc"),
          txBuffer: fakeAddress("buf"),
          zkbtcMint: fakeAddress("mint"),
          poolVault: fakeAddress("vault"),
          completionReceipt: fakeAddress("cr"),
          poolConfig: fakeAddress("pc"),
          changeUtxo: fakeAddress("change"),
          consumedUtxos: [fakeAddress("u0"), fakeAddress("u1"), fakeAddress("u2")],
        },
      });
      expect(ix.accounts.length).toBe(17);
    });

    it("account order matches Rust: pool(w), redemption(w), authority(ws), rent(r), vt(r), lc(r), buf(r), mint(w), vault(w), token(r), receipt(w), system(r), config(r), change(w)", () => {
      const ix = buildCompleteRedemptionInstruction({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 225,
        poolScript: new Uint8Array(0),
        consumedUtxoCount: 0,
        accounts: {
          poolState: fakeAddress("pool"),
          redemptionRequest: fakeAddress("rr"),
          authority: fakeAddress("auth"),
          rentRecipient: fakeAddress("rent"),
          verifiedTransaction: fakeAddress("vt"),
          lightClient: fakeAddress("lc"),
          txBuffer: fakeAddress("buf"),
          zkbtcMint: fakeAddress("mint"),
          poolVault: fakeAddress("vault"),
          completionReceipt: fakeAddress("cr"),
          poolConfig: fakeAddress("pc"),
          changeUtxo: fakeAddress("change"),
        },
      });
      expect(ix.accounts[0].role).toBe(AccountRole.WRITABLE);           // pool_state
      expect(ix.accounts[1].role).toBe(AccountRole.WRITABLE);           // redemption_request
      expect(ix.accounts[2].role).toBe(AccountRole.WRITABLE_SIGNER);   // authority
      expect(ix.accounts[3].role).toBe(AccountRole.READONLY);           // rent_recipient
      expect(ix.accounts[4].role).toBe(AccountRole.READONLY);           // verified_transaction
      expect(ix.accounts[5].role).toBe(AccountRole.READONLY);           // light_client
      expect(ix.accounts[6].role).toBe(AccountRole.READONLY);           // tx_buffer
      expect(ix.accounts[7].role).toBe(AccountRole.WRITABLE);           // zkbtc_mint
      expect(ix.accounts[8].role).toBe(AccountRole.WRITABLE);           // pool_vault
      expect(ix.accounts[9].role).toBe(AccountRole.READONLY);           // token_program
      expect(ix.accounts[10].role).toBe(AccountRole.WRITABLE);          // completion_receipt
      expect(ix.accounts[11].role).toBe(AccountRole.READONLY);          // system_program
      expect(ix.accounts[12].role).toBe(AccountRole.READONLY);          // pool_config
      expect(ix.accounts[13].role).toBe(AccountRole.WRITABLE);          // change_utxo
    });

    it("consumed UTXO accounts are all WRITABLE", () => {
      const ix = buildCompleteRedemptionInstruction({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 225,
        poolScript: filledBytes(34, 0x77),
        consumedUtxoCount: 2,
        accounts: {
          poolState: fakeAddress("pool"),
          redemptionRequest: fakeAddress("rr"),
          authority: fakeAddress("auth"),
          rentRecipient: fakeAddress("rent"),
          verifiedTransaction: fakeAddress("vt"),
          lightClient: fakeAddress("lc"),
          txBuffer: fakeAddress("buf"),
          zkbtcMint: fakeAddress("mint"),
          poolVault: fakeAddress("vault"),
          completionReceipt: fakeAddress("cr"),
          poolConfig: fakeAddress("pc"),
          changeUtxo: fakeAddress("change"),
          consumedUtxos: [fakeAddress("u0"), fakeAddress("u1")],
        },
      });
      // Consumed UTXOs at index 14, 15
      expect(ix.accounts[14].role).toBe(AccountRole.WRITABLE);
      expect(ix.accounts[15].role).toBe(AccountRole.WRITABLE);
    });
  });

  describe("edge cases", () => {
    it("empty pool_script produces pool_script_len=0", () => {
      const data = buildCompleteRedemptionInstructionData({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 225,
        poolScript: new Uint8Array(0),
        consumedUtxoCount: 0,
      });
      const cd = data.slice(1);
      expect(cd[36]).toBe(0);
    });

    it("no consumed UTXOs: buildCompleteRedemptionInstruction with undefined consumedUtxos", () => {
      const ix = buildCompleteRedemptionInstruction({
        btcTxid: filledBytes(32, 0xaa),
        txSize: 225,
        poolScript: new Uint8Array(0),
        consumedUtxoCount: 0,
        accounts: {
          poolState: fakeAddress("pool"),
          redemptionRequest: fakeAddress("rr"),
          authority: fakeAddress("auth"),
          rentRecipient: fakeAddress("rent"),
          verifiedTransaction: fakeAddress("vt"),
          lightClient: fakeAddress("lc"),
          txBuffer: fakeAddress("buf"),
          zkbtcMint: fakeAddress("mint"),
          poolVault: fakeAddress("vault"),
          completionReceipt: fakeAddress("cr"),
          poolConfig: fakeAddress("pc"),
          changeUtxo: fakeAddress("change"),
          // consumedUtxos intentionally omitted
        },
      });
      // Should only have the 14 base accounts
      expect(ix.accounts.length).toBe(14);
    });

    it("large tx_size is correctly LE-encoded", () => {
      const txSize = 0x00FFFFFF; // near u32 max
      const data = buildCompleteRedemptionInstructionData({
        btcTxid: filledBytes(32, 0xaa),
        txSize,
        poolScript: new Uint8Array(0),
        consumedUtxoCount: 0,
      });
      const cd = data.slice(1);
      const parsed = new DataView(cd.buffer, cd.byteOffset).getUint32(32, true);
      expect(parsed).toBe(txSize);
    });
  });
});

// =============================================================================
// Cross-builder consistency checks
// =============================================================================

describe("Cross-layer: instruction discriminator uniqueness", () => {
  it("all 4 builders produce distinct discriminators", () => {
    const discs = new Set([
      DISC_TRANSACT,
      DISC_UNSHIELD,
      DISC_REQUEST_REDEMPTION,
      DISC_COMPLETE_REDEMPTION,
    ]);
    expect(discs.size).toBe(4);
  });

  it("discriminators match INSTRUCTION_DISCRIMINATORS export", () => {
    // Import the exported constants to verify they match
    const { INSTRUCTION_DISCRIMINATORS } = require("../../src/instructions");
    expect(INSTRUCTION_DISCRIMINATORS.TRANSACT).toBe(DISC_TRANSACT);
    expect(INSTRUCTION_DISCRIMINATORS.UNSHIELD).toBe(DISC_UNSHIELD);
    expect(INSTRUCTION_DISCRIMINATORS.REQUEST_REDEMPTION).toBe(DISC_REQUEST_REDEMPTION);
    expect(INSTRUCTION_DISCRIMINATORS.COMPLETE_REDEMPTION).toBe(DISC_COMPLETE_REDEMPTION);
  });
});
