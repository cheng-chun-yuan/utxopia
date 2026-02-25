pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/eddsaposeidon.circom";
include "circomlib/circuits/bitify.circom";
include "./lib/merkle.circom";
include "./lib/joinsplit_commitment.circom";
include "./lib/joinsplit_nullifier.circom";
include "./lib/mpk.circom";

/**
 * JoinSplit Circuit (Railgun-aligned)
 *
 * Parameterized template: JoinSplit(nInputs, nOutputs, treeDepth)
 * Produces one circuit per (N, M) variant. Constraint: N + M <= 14.
 *
 * Public signals:
 *   merkleRoot       - Root of the commitment Merkle tree
 *   boundParamsHash  - Hash binding treeNumber, unshield address, chainId
 *   nullifiers[N]    - One nullifier per input (prevents double-spend)
 *   commitmentsOut[M]- One commitment per output
 *
 * Private signals:
 *   token            - Token identifier (ZBTC_TOKEN_ID)
 *   publicKey[2]     - Baby Jubjub spending public key (x, y)
 *   signature[3]     - EdDSA-Poseidon signature (R8x, R8y, S)
 *   nullifyingKey    - Nullifying key from 3-key model
 *   randomIn[N]      - Random blinding factor per input note
 *   valueIn[N]       - Amount per input note
 *   pathElements[N][treeDepth] - Merkle proof siblings per input
 *   pathIndices[N][treeDepth]  - Merkle proof directions per input
 *   leavesIndices[N] - Leaf index per input (for nullifier)
 *   npkOut[M]        - Note public key per output
 *   valueOut[M]      - Amount per output
 *
 * Logic:
 *   1. MPK = Poseidon(publicKey[0], publicKey[1], nullifyingKey)
 *   2. For each input:
 *      - NPK = Poseidon(MPK, randomIn[i])
 *      - commitment = Poseidon(NPK, token, valueIn[i])
 *      - verify Merkle proof (commitment in tree)
 *      - nullifier = Poseidon(nullifyingKey, leavesIndices[i])
 *   3. For each output:
 *      - verify commitmentsOut[j] == Poseidon(npkOut[j], token, valueOut[j])
 *      - range check: valueOut[j] fits in 120 bits
 *   4. sum(valueIn) === sum(valueOut)
 *   5. msgHash = Poseidon(merkleRoot, boundParamsHash, nullifiers..., commitmentsOut...)
 *   6. EdDSA-Poseidon signature verification
 */
template JoinSplit(nInputs, nOutputs, treeDepth) {
    // ============================
    // Public signals
    // ============================
    signal input merkleRoot;
    signal input boundParamsHash;
    signal input nullifiers[nInputs];
    signal input commitmentsOut[nOutputs];

    // ============================
    // Private signals
    // ============================
    signal input token;
    signal input publicKey[2];       // BJJ (x, y)
    signal input signature[3];       // EdDSA-Poseidon (R8x, R8y, S)
    signal input nullifyingKey;

    // Per-input note data
    signal input randomIn[nInputs];
    signal input valueIn[nInputs];
    signal input pathElements[nInputs][treeDepth];
    signal input pathIndices[nInputs][treeDepth];
    signal input leavesIndices[nInputs];

    // Per-output note data
    signal input npkOut[nOutputs];
    signal input valueOut[nOutputs];

    // ============================
    // 1. Compute Master Public Key
    // ============================
    component mpkHash = MasterPublicKey();
    mpkHash.pkX <== publicKey[0];
    mpkHash.pkY <== publicKey[1];
    mpkHash.nullifyingKey <== nullifyingKey;

    // ============================
    // 2. Process inputs
    // ============================
    component inputNpkHashers[nInputs];
    component inputCommitments[nInputs];
    component inputMerkle[nInputs];
    component inputNullifiers[nInputs];

    signal sumIn[nInputs + 1];
    sumIn[0] <== 0;

    for (var i = 0; i < nInputs; i++) {
        // NPK = Poseidon(MPK, randomIn[i])
        inputNpkHashers[i] = Poseidon(2);
        inputNpkHashers[i].inputs[0] <== mpkHash.mpk;
        inputNpkHashers[i].inputs[1] <== randomIn[i];

        // Commitment = Poseidon(NPK, token, valueIn[i])
        inputCommitments[i] = JoinSplitCommitment();
        inputCommitments[i].npk <== inputNpkHashers[i].out;
        inputCommitments[i].token <== token;
        inputCommitments[i].amount <== valueIn[i];

        // Verify Merkle proof
        inputMerkle[i] = MerkleProofVerifier(treeDepth);
        inputMerkle[i].leaf <== inputCommitments[i].commitment;
        for (var j = 0; j < treeDepth; j++) {
            inputMerkle[i].path_elements[j] <== pathElements[i][j];
            inputMerkle[i].path_indices[j] <== pathIndices[i][j];
        }
        inputMerkle[i].root === merkleRoot;

        // Verify nullifier = Poseidon(nullifyingKey, leavesIndices[i])
        inputNullifiers[i] = JoinSplitNullifier();
        inputNullifiers[i].nullifyingKey <== nullifyingKey;
        inputNullifiers[i].leafIndex <== leavesIndices[i];
        inputNullifiers[i].nullifier === nullifiers[i];

        // Accumulate input sum
        sumIn[i + 1] <== sumIn[i] + valueIn[i];
    }

    // ============================
    // 3. Process outputs
    // ============================
    component outputCommitments[nOutputs];
    component outputRangeChecks[nOutputs];

    signal sumOut[nOutputs + 1];
    sumOut[0] <== 0;

    for (var i = 0; i < nOutputs; i++) {
        // Verify output commitment = Poseidon(npkOut[i], token, valueOut[i])
        outputCommitments[i] = JoinSplitCommitment();
        outputCommitments[i].npk <== npkOut[i];
        outputCommitments[i].token <== token;
        outputCommitments[i].amount <== valueOut[i];
        outputCommitments[i].commitment === commitmentsOut[i];

        // Range check: valueOut fits in 120 bits
        outputRangeChecks[i] = Num2Bits(120);
        outputRangeChecks[i].in <== valueOut[i];

        // Accumulate output sum
        sumOut[i + 1] <== sumOut[i] + valueOut[i];
    }

    // ============================
    // 4. Amount conservation
    // ============================
    sumIn[nInputs] === sumOut[nOutputs];

    // ============================
    // 5. Compute message hash for EdDSA signature
    // ============================
    // msgHash = Poseidon(merkleRoot, boundParamsHash, nullifiers..., commitmentsOut...)
    // Arity = 2 + nInputs + nOutputs (must be <= 16)
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
    // 6. EdDSA-Poseidon signature verification
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
