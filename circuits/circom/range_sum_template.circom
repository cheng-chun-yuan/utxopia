pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/babyjub.circom";
include "./lib/merkle.circom";
include "./lib/mpk.circom";
include "./lib/joinsplit_commitment.circom";

/**
 * Range-sum disclosure — Phase 4
 *
 * Proves: "the prover-owned commitments at leafIndices[0..N] have value sum
 * ≤ ceiling, anchored at merkleRoot, all under tokenId."
 *
 * Coverage (i.e. "these are *all* the prover's notes in some range") is NOT
 * provable from inside the circuit alone — the verifier independently obtains
 * the full set of the prover's leaf indices via the auditor flow (Phase 1)
 * and computes `attestation = Poseidon(leafIndices ++ [viewerNonce])` to
 * confirm it matches the public input. Mismatch ⇒ the prover hid notes.
 *
 * For now this template fixes N at compile time (one VK per cardinality).
 * In practice we instantiate range_sum (N=8) plus companion variants
 * range_sum_4 and range_sum_16 via sibling files.
 *
 * Public signals:
 *   leafIndices[N]   - Indices of the disclosed notes
 *   merkleRoot       - JoinSplit tree root
 *   ceiling          - Asserted upper bound on the sum
 *   token            - Token id
 *   attestation      - Poseidon(leafIndices, viewerNonce)
 *
 * Private signals:
 *   spendingPrivScalar
 *   nullifyingKey
 *   randomIn[N]
 *   valueIn[N]
 *   pathElements[N][16]
 *   pathIndices[N][16]
 *   viewerNonce      - Salt the verifier provided; baked into attestation only
 *   commitmentsIn[N] - Witness commitments (verified against tree + computation)
 *
 * Constraints:
 *   1. derive spendingPub, MPK
 *   2. for each i: commitment[i] == Poseidon(NPK[i], token, valueIn[i])
 *   3. for each i: commitment[i] ∈ tree(merkleRoot)
 *   4. Σ valueIn[i] <= ceiling
 *   5. attestation == Poseidon(leafIndices ++ [viewerNonce])
 */
template RangeSum(n, treeDepth) {
    // Public
    signal input leafIndices[n];
    signal input merkleRoot;
    signal input ceiling;
    signal input token;
    signal input attestation;

    // Private
    signal input spendingPrivScalar;
    signal input nullifyingKey;
    signal input randomIn[n];
    signal input valueIn[n];
    signal input pathElements[n][treeDepth];
    signal input pathIndices[n][treeDepth];
    signal input viewerNonce;
    signal input commitmentsIn[n];

    // 1. spending pub + MPK
    component spendingPub = BabyPbk();
    spendingPub.in <== spendingPrivScalar;

    component mpk = MasterPublicKey();
    mpk.pkX <== spendingPub.Ax;
    mpk.pkY <== spendingPub.Ay;
    mpk.nullifyingKey <== nullifyingKey;

    // 2 & 3. per-note commitment binding + Merkle inclusion
    component npkHasher[n];
    component commitmentCheck[n];
    component verifier[n];
    for (var i = 0; i < n; i++) {
        npkHasher[i] = Poseidon(2);
        npkHasher[i].inputs[0] <== mpk.mpk;
        npkHasher[i].inputs[1] <== randomIn[i];

        commitmentCheck[i] = JoinSplitCommitment();
        commitmentCheck[i].npk <== npkHasher[i].out;
        commitmentCheck[i].token <== token;
        commitmentCheck[i].amount <== valueIn[i];
        commitmentsIn[i] === commitmentCheck[i].commitment;

        verifier[i] = MerkleProofVerifier(treeDepth);
        verifier[i].leaf <== commitmentsIn[i];
        for (var j = 0; j < treeDepth; j++) {
            verifier[i].path_elements[j] <== pathElements[i][j];
            verifier[i].path_indices[j] <== pathIndices[i][j];
        }
        verifier[i].root === merkleRoot;
    }

    // 4. sum check — running sum accumulator, then range check
    signal sum[n + 1];
    sum[0] <== 0;
    for (var i = 0; i < n; i++) {
        sum[i + 1] <== sum[i] + valueIn[i];
    }

    component cmp = LessEqThan(124);
    cmp.in[0] <== sum[n];
    cmp.in[1] <== ceiling;
    cmp.out === 1;

    // 5. attestation binds the disclosed set of leaf indices + verifier's nonce.
    // Variable-arity Poseidon is awkward in circom; for the v1 we fix N and
    // hash as Poseidon(n+1) with leafIndices in slots 0..n-1 and viewerNonce
    // in slot n.
    component attHasher = Poseidon(n + 1);
    for (var i = 0; i < n; i++) {
        attHasher.inputs[i] <== leafIndices[i];
    }
    attHasher.inputs[n] <== viewerNonce;
    attHasher.out === attestation;
}
