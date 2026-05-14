/**
 * Phase 3d-full prototype — JoinSplit-with-PoI instruction builder.
 *
 * Today this only supports the (1, 2) variant. Other (N, M) variants need
 * their own compiled circuit + VK constants + a parallel verifier function
 * in the Rust contract; see `circuits/circom/joinsplit_with_poi.circom` for
 * the template and `TODOS.md` for the scale-out plan.
 *
 * The on-chain `transact_with_poi` (disc 26) is a *co-attestation* — it
 * verifies the augmented proof and emits an event tagging
 * `(nullifier, commitment_out_0, commitment_out_1, association_root)`.
 * Pair it with a regular `transact` (disc 13) in the same Solana
 * transaction; downstream consumers match the events on those fields to
 * conclude "this transact's input was clean."
 */

const INSTRUCTION_TRANSACT_WITH_POI = 26;
const GROTH16_PROOF_BYTES = 256;

/**
 * Build instruction data for `transact_with_poi` (disc 26) — 1x2 variant.
 *
 * Layout (418 bytes):
 *   disc(1) + n_inputs(1=1) + n_outputs(1=2) + proof(256)
 *   + merkle_root(32) + bound_params_hash(32) + nullifier(32)
 *   + commitment_out_0(32) + commitment_out_1(32)
 *
 * Note: unlike `transact` (which supports inline + buffer modes), the
 * prototype only supports inline proofs — the augmented Groth16 proof is
 * still 256 bytes, so the buffer mode optimization isn't needed yet.
 */
export function buildTransactWithPoIInstructionData(options: {
  /** 256-byte Groth16-with-PoI proof. */
  proofBytes: Uint8Array;
  merkleRoot: Uint8Array;
  boundParamsHash: Uint8Array;
  nullifier: Uint8Array;
  commitmentOut0: Uint8Array;
  commitmentOut1: Uint8Array;
}): Uint8Array {
  const expect = (buf: Uint8Array, len: number, name: string) => {
    if (buf.length !== len) {
      throw new Error(`${name} must be ${len} bytes; got ${buf.length}`);
    }
  };
  expect(options.proofBytes, GROTH16_PROOF_BYTES, "proofBytes");
  expect(options.merkleRoot, 32, "merkleRoot");
  expect(options.boundParamsHash, 32, "boundParamsHash");
  expect(options.nullifier, 32, "nullifier");
  expect(options.commitmentOut0, 32, "commitmentOut0");
  expect(options.commitmentOut1, 32, "commitmentOut1");

  // 1 + 1 + 1 + 256 + 32 + 32 + 32 + 32 + 32 = 419
  const out = new Uint8Array(1 + 1 + 1 + GROTH16_PROOF_BYTES + 32 * 5);
  let off = 0;
  out[off++] = INSTRUCTION_TRANSACT_WITH_POI;
  out[off++] = 1; // n_inputs
  out[off++] = 2; // n_outputs
  out.set(options.proofBytes, off);
  off += GROTH16_PROOF_BYTES;
  out.set(options.merkleRoot, off);
  off += 32;
  out.set(options.boundParamsHash, off);
  off += 32;
  out.set(options.nullifier, off);
  off += 32;
  out.set(options.commitmentOut0, off);
  off += 32;
  out.set(options.commitmentOut1, off);
  return out;
}
