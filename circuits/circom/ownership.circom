pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/babyjub.circom";
include "./lib/merkle.circom";
include "./lib/mpk.circom";
include "./lib/joinsplit_commitment.circom";

/**
 * Ownership proof — Phase 4 skeleton
 *
 * Proves: "I own commitment X (it's in the tree), and its value ≥ threshold."
 *
 * Does NOT emit a nullifier — generating this proof does not spend the note.
 * This makes it safe to share with auditors / regulators on demand.
 *
 * Public signals:
 *   commitment       - The note commitment being attested to
 *   merkleRoot       - JoinSplit tree root the commitment must be inside
 *   threshold        - Minimum amount the prover claims the note holds
 *   token            - Token id (so caller can't equivocate across tokens)
 *
 * Private signals:
 *   spendingPrivScalar - Baby Jubjub spending private scalar
 *   randomIn           - Randomness used in NPK derivation
 *   valueIn            - Actual amount
 *   pathElements[16]   - Merkle path siblings
 *   pathIndices[16]    - Merkle path direction bits
 *   nullifyingKey      - BN254 nullifying key
 *
 * Constraints:
 *   1. spendingPub = BabyPbk(spendingPrivScalar)
 *   2. MPK = Poseidon(spendingPub.x, spendingPub.y, nullifyingKey)
 *   3. NPK = Poseidon(MPK, randomIn)
 *   4. commitment === Poseidon(NPK, token, valueIn)
 *   5. commitment ∈ tree(merkleRoot)
 *   6. valueIn >= threshold   (via GreaterEqThan)
 */
template OwnershipProof(treeDepth) {
    // Public
    signal input commitment;
    signal input merkleRoot;
    signal input threshold;
    signal input token;

    // Private
    signal input spendingPrivScalar;
    signal input randomIn;
    signal input valueIn;
    signal input pathElements[treeDepth];
    signal input pathIndices[treeDepth];
    signal input nullifyingKey;

    // 1. spending pubkey from private scalar
    component spendingPub = BabyPbk();
    spendingPub.in <== spendingPrivScalar;

    // 2. MPK
    component mpk = MasterPublicKey();
    mpk.pkX <== spendingPub.Ax;
    mpk.pkY <== spendingPub.Ay;
    mpk.nullifyingKey <== nullifyingKey;

    // 3. NPK = Poseidon(MPK, randomIn)
    component npkHasher = Poseidon(2);
    npkHasher.inputs[0] <== mpk.mpk;
    npkHasher.inputs[1] <== randomIn;

    // 4. commitment === Poseidon(NPK, token, valueIn)
    component commitmentCheck = JoinSplitCommitment();
    commitmentCheck.npk <== npkHasher.out;
    commitmentCheck.token <== token;
    commitmentCheck.amount <== valueIn;
    commitment === commitmentCheck.commitment;

    // 5. Merkle inclusion
    component verifier = MerkleProofVerifier(treeDepth);
    verifier.leaf <== commitment;
    for (var i = 0; i < treeDepth; i++) {
        verifier.path_elements[i] <== pathElements[i];
        verifier.path_indices[i] <== pathIndices[i];
    }
    verifier.root === merkleRoot;

    // 6. valueIn >= threshold (120-bit range check matches JoinSplit's value bounds)
    component cmp = GreaterEqThan(120);
    cmp.in[0] <== valueIn;
    cmp.in[1] <== threshold;
    cmp.out === 1;
}

component main { public [commitment, merkleRoot, threshold, token] } = OwnershipProof(16);
