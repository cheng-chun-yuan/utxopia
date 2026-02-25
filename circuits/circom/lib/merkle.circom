pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";

/**
 * Merkle proof verifier using Poseidon hash
 * Verifies a leaf belongs to a Merkle tree with given root.
 *
 * @param levels - Tree depth (default 16 for zVault JoinSplit)
 */
template MerkleProofVerifier(levels) {
    signal input leaf;
    signal input path_elements[levels];
    signal input path_indices[levels];
    signal output root;

    component hashers[levels];
    component mux[levels];

    signal hashes[levels + 1];
    hashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // Ensure path_indices are binary
        path_indices[i] * (1 - path_indices[i]) === 0;

        hashers[i] = Poseidon(2);
        mux[i] = MultiMux1(2);

        // If path_index == 0: hash(current, sibling)
        // If path_index == 1: hash(sibling, current)
        mux[i].c[0][0] <== hashes[i];
        mux[i].c[0][1] <== path_elements[i];
        mux[i].c[1][0] <== path_elements[i];
        mux[i].c[1][1] <== hashes[i];
        mux[i].s <== path_indices[i];

        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];

        hashes[i + 1] <== hashers[i].out;
    }

    root <== hashes[levels];
}
