pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/eddsaposeidon.circom";
include "circomlib/circuits/bitify.circom";
include "./lib/merkle.circom";
include "./lib/joinsplit_commitment.circom";
include "./lib/joinsplit_nullifier.circom";
include "./lib/mpk.circom";

/**
 * JoinSplitWithPoI — JoinSplit + per-input association-tree membership proof.
 *
 * Same semantics as JoinSplit(N, M, treeDepth) but ALSO proves, for each of
 * the N input commitments, membership in a separate "association set"
 * Merkle tree (depth = assocDepth). The association root is a public
 * input so the on-chain verifier can pin it to the AssociationSet PDA's
 * current_root before accepting the proof.
 *
 * SYNCHRONIZE WITH `joinsplit.circom` — the JoinSplit logic below is
 * intentionally a verbatim copy. When the upstream JoinSplit body
 * changes (e.g. a new constraint), mirror the change here too.
 *
 * Why duplicate instead of composing? circom sub-component templates
 * would require forwarding every signal through a wrapper, which is
 * messier than the duplication.
 *
 * Public signals (vs vanilla JoinSplit, this adds `associationRoot`):
 *   merkleRoot         - Root of the JoinSplit commitment tree
 *   boundParamsHash    - Existing bound-params hash
 *   nullifiers[N]      - One per input
 *   commitmentsOut[M]  - One per output
 *   associationRoot    - Root of the PoI association tree (depth 20)
 *
 * Additional private signals (vs vanilla):
 *   assocPathElements[N][assocDepth] - Merkle proof in the association tree
 *   assocPathIndices[N][assocDepth]
 *
 * Additional constraint: for each input i,
 *   commitment[i] ∈ associationTree(associationRoot)
 */
template JoinSplitWithPoI(nInputs, nOutputs, treeDepth, assocDepth) {
    // ============================
    // Public signals
    // ============================
    signal input merkleRoot;
    signal input boundParamsHash;
    signal input nullifiers[nInputs];
    signal input commitmentsOut[nOutputs];
    signal input associationRoot;

    // ============================
    // Private signals
    // ============================
    signal input token;
    signal input publicKey[2];
    signal input signature[3];
    signal input nullifyingKey;

    signal input randomIn[nInputs];
    signal input valueIn[nInputs];
    signal input pathElements[nInputs][treeDepth];
    signal input pathIndices[nInputs][treeDepth];
    signal input leavesIndices[nInputs];

    signal input assocPathElements[nInputs][assocDepth];
    signal input assocPathIndices[nInputs][assocDepth];

    signal input npkOut[nOutputs];
    signal input valueOut[nOutputs];

    // ============================
    // 1. MPK
    // ============================
    component mpkHash = MasterPublicKey();
    mpkHash.pkX <== publicKey[0];
    mpkHash.pkY <== publicKey[1];
    mpkHash.nullifyingKey <== nullifyingKey;

    // ============================
    // 2. Inputs (commitment + JoinSplit Merkle proof + nullifier + range)
    //    + Phase 3d-full: association-tree Merkle proof
    // ============================
    component inputNpkHashers[nInputs];
    component inputCommitments[nInputs];
    component inputMerkle[nInputs];
    component inputAssocMerkle[nInputs];
    component inputNullifiers[nInputs];
    component inputRangeChecks[nInputs];

    signal sumIn[nInputs + 1];
    sumIn[0] <== 0;

    for (var i = 0; i < nInputs; i++) {
        inputNpkHashers[i] = Poseidon(2);
        inputNpkHashers[i].inputs[0] <== mpkHash.mpk;
        inputNpkHashers[i].inputs[1] <== randomIn[i];

        inputCommitments[i] = JoinSplitCommitment();
        inputCommitments[i].npk <== inputNpkHashers[i].out;
        inputCommitments[i].token <== token;
        inputCommitments[i].amount <== valueIn[i];

        // JoinSplit tree membership (existing)
        inputMerkle[i] = MerkleProofVerifier(treeDepth);
        inputMerkle[i].leaf <== inputCommitments[i].commitment;
        for (var j = 0; j < treeDepth; j++) {
            inputMerkle[i].path_elements[j] <== pathElements[i][j];
            inputMerkle[i].path_indices[j] <== pathIndices[i][j];
        }
        inputMerkle[i].root === merkleRoot;

        // Phase 3d-full: ALSO assert membership in the association tree.
        // The same commitment must be in the curated clean-set anchored
        // at `associationRoot`. The user-facing UX: "I'm spending notes
        // whose origins are clean by the curator's standards."
        inputAssocMerkle[i] = MerkleProofVerifier(assocDepth);
        inputAssocMerkle[i].leaf <== inputCommitments[i].commitment;
        for (var j = 0; j < assocDepth; j++) {
            inputAssocMerkle[i].path_elements[j] <== assocPathElements[i][j];
            inputAssocMerkle[i].path_indices[j] <== assocPathIndices[i][j];
        }
        inputAssocMerkle[i].root === associationRoot;

        inputNullifiers[i] = JoinSplitNullifier();
        inputNullifiers[i].nullifyingKey <== nullifyingKey;
        inputNullifiers[i].leafIndex <== leavesIndices[i];
        inputNullifiers[i].nullifier === nullifiers[i];

        inputRangeChecks[i] = Num2Bits(120);
        inputRangeChecks[i].in <== valueIn[i];

        sumIn[i + 1] <== sumIn[i] + valueIn[i];
    }

    // ============================
    // 3. Outputs (unchanged)
    // ============================
    component outputCommitments[nOutputs];
    component outputRangeChecks[nOutputs];

    signal sumOut[nOutputs + 1];
    sumOut[0] <== 0;

    for (var i = 0; i < nOutputs; i++) {
        outputCommitments[i] = JoinSplitCommitment();
        outputCommitments[i].npk <== npkOut[i];
        outputCommitments[i].token <== token;
        outputCommitments[i].amount <== valueOut[i];
        outputCommitments[i].commitment === commitmentsOut[i];

        outputRangeChecks[i] = Num2Bits(120);
        outputRangeChecks[i].in <== valueOut[i];

        sumOut[i + 1] <== sumOut[i] + valueOut[i];
    }

    // ============================
    // 4. Amount conservation (unchanged)
    // ============================
    sumIn[nInputs] === sumOut[nOutputs];

    // ============================
    // 5. msgHash — note: associationRoot is NOT included in the EdDSA
    //    message. It's a public input the on-chain verifier pins to the
    //    PDA, not something the signer attests to. Including it would
    //    force re-signing whenever the curator rolls the root, which is
    //    not the intended UX.
    // ============================
    var hashArity = 2 + nInputs + nOutputs;
    component msgHasher = Poseidon(hashArity);
    msgHasher.inputs[0] <== merkleRoot;
    msgHasher.inputs[1] <== boundParamsHash;
    for (var i = 0; i < nInputs; i++) {
        msgHasher.inputs[2 + i] <== nullifiers[i];
    }
    for (var i = 0; i < nOutputs; i++) {
        msgHasher.inputs[2 + nInputs + i] <== commitmentsOut[i];
    }

    // ============================
    // 6. EdDSA-Poseidon signature verification (unchanged)
    // ============================
    component sigVerifier = EdDSAPoseidonVerifier();
    sigVerifier.enabled <== 1;
    sigVerifier.Ax <== publicKey[0];
    sigVerifier.Ay <== publicKey[1];
    sigVerifier.R8x <== signature[0];
    sigVerifier.R8y <== signature[1];
    sigVerifier.S <== signature[2];
    sigVerifier.M <== msgHasher.out;
}
