pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/babyjub.circom";
include "./lib/merkle.circom";
include "./lib/mpk.circom";
include "./lib/joinsplit_commitment.circom";

/**
 * Range-sum disclosure — N=16 variant with chunked attestation.
 *
 * Same semantics as `RangeSum(n, 16)` from range_sum_template.circom, but
 * circomlib's Poseidon caps at arity 16, so the flat
 * `Poseidon(leafIndices ++ [viewerNonce])` overflows at N=16 (would need
 * Poseidon(17)). This variant chunks the attestation:
 *
 *     chunk1     = Poseidon(leafIndices[0..8])     // 8 inputs
 *     chunk2     = Poseidon(leafIndices[8..16])    // 8 inputs
 *     attestation = Poseidon(chunk1, chunk2, viewerNonce)  // 3 inputs
 *
 * The SDK + CLI mirror this construction; mismatch → verifier rejects.
 * Compiled to its own zkey because the witness shape differs from the
 * flat-hash variants.
 */
template RangeSum16(treeDepth) {
    var n = 16;

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

    // 5. Chunked attestation.
    component chunk1 = Poseidon(8);
    component chunk2 = Poseidon(8);
    for (var i = 0; i < 8; i++) {
        chunk1.inputs[i] <== leafIndices[i];
        chunk2.inputs[i] <== leafIndices[8 + i];
    }
    component attHasher = Poseidon(3);
    attHasher.inputs[0] <== chunk1.out;
    attHasher.inputs[1] <== chunk2.out;
    attHasher.inputs[2] <== viewerNonce;
    attHasher.out === attestation;
}

component main { public [leafIndices, merkleRoot, ceiling, token, attestation] } = RangeSum16(16);
