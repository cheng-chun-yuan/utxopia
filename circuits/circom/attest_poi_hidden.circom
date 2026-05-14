pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "./lib/merkle.circom";

/**
 * Hidden-commitment Proof of Innocence (Phase 3d-lite).
 *
 * Same association-tree membership as `proof_of_innocence.circom`, but the
 * commitment is bound to the proof via a Poseidon-2 blinding instead of
 * being a public input. Chain watchers see only `blindedId`; the auditor
 * receiving the proof gets `nonce` out-of-band and re-derives
 * `Poseidon(commitment, nonce)` to verify the binding.
 *
 * Threat model:
 *   - Chain watchers learn: "some commitment from the association set was
 *     attested." They can't link the attestation to a specific commitment
 *     unless they brute-force `nonce` (240 bits of entropy → infeasible).
 *   - Auditor learns: "commitment X is in the association set, and the user
 *     proved knowledge of `nonce` binding it to this attestation."
 *   - Operator (curating the association set) learns nothing new — they
 *     already see every commitment they include.
 *
 * Public signals:
 *   associationRoot  - Root of the off-chain-curated clean set
 *   blindedId        - Poseidon(commitment, nonce), 254-bit BN254 field elt
 *
 * Private signals:
 *   commitment              - The commitment whose innocence we're proving
 *   nonce                   - Random 240-bit blinding factor
 *   pathElements[depth]     - Merkle proof against the association tree
 *   pathIndices[depth]      - Direction bits
 *
 * Constraints:
 *   1. blindedId == Poseidon(commitment, nonce)
 *   2. commitment ∈ associationTree(root=associationRoot)
 */
template AttestPoIHidden(treeDepth) {
    // Public
    signal input associationRoot;
    signal input blindedId;

    // Private
    signal input commitment;
    signal input nonce;
    signal input pathElements[treeDepth];
    signal input pathIndices[treeDepth];

    // 1. Bind the commitment to a public blinded ID.
    component binder = Poseidon(2);
    binder.inputs[0] <== commitment;
    binder.inputs[1] <== nonce;
    binder.out === blindedId;

    // 2. Verify the commitment is in the association set.
    component verifier = MerkleProofVerifier(treeDepth);
    verifier.leaf <== commitment;
    for (var i = 0; i < treeDepth; i++) {
        verifier.path_elements[i] <== pathElements[i];
        verifier.path_indices[i] <== pathIndices[i];
    }
    verifier.root === associationRoot;
}

// Tree depth must match `proof_of_innocence.circom` (= POI_TREE_DEPTH in
// the SDK) so both variants share the same association root.
component main { public [associationRoot, blindedId] } = AttestPoIHidden(20);
