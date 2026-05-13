pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "./lib/merkle.circom";

/**
 * Proof of Innocence (PoI) — Phase 3 skeleton
 *
 * Proves that a given commitment (the *origin* of the user's withdrawal, e.g.
 * the deposit commitment for a single-hop unshield) is in the protocol's
 * association set of "clean" commitments. The association set is built and
 * curated off-chain — typically the set of SPV-verified BTC deposits passing
 * AML screening at deposit time.
 *
 * This is the simple variant: lineage is NOT tracked through JoinSplits, so
 * the proof only meaningfully applies when the withdrawn note is still its
 * original deposit commitment (no transact in between), OR when the operator
 * separately attests to a JoinSplit lineage chain.
 *
 * Full lineage-through-JoinSplit (Tornado Nova / Privacy Pools v2 style)
 * requires either:
 *   (a) carrying a "taint tag" inside every commitment (changes commitment
 *       layout — breaking change), or
 *   (b) a separate lineage tree maintained off-chain with batched roots
 *       posted to the association set.
 *
 * That decision is deferred — see [[auditable-disclosure-status]].
 *
 * Public signals:
 *   associationRoot  - Root of the off-chain-curated clean set
 *   commitment       - Commitment whose innocence we are proving
 *
 * Private signals:
 *   pathElements[depth]   - Merkle proof against the association tree
 *   pathIndices[depth]    - Direction bits
 *
 * Constraints:
 *   1. Verify Merkle proof: commitment ∈ associationTree(root=associationRoot)
 */
template ProofOfInnocence(treeDepth) {
    signal input associationRoot;
    signal input commitment;

    signal input pathElements[treeDepth];
    signal input pathIndices[treeDepth];

    component verifier = MerkleProofVerifier(treeDepth);
    verifier.leaf <== commitment;
    for (var i = 0; i < treeDepth; i++) {
        verifier.path_elements[i] <== pathElements[i];
        verifier.path_indices[i] <== pathIndices[i];
    }

    verifier.root === associationRoot;
}

// Tree depth 20 = ~1M elements — plenty of headroom over the JoinSplit
// commitment tree (depth 16 = 65k). Bumping later is non-breaking; the VK
// just gets re-registered.
component main { public [associationRoot, commitment] } = ProofOfInnocence(20);
