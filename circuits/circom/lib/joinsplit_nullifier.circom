pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

/**
 * JoinSplit Nullifier (Railgun-aligned)
 * nullifier = Poseidon(nullifyingKey, leafIndex)
 *
 * No extra hash layer — the nullifier IS the public output.
 *
 * @input nullifyingKey - The nullifying key from 3-key model
 * @input leafIndex - Leaf position in the Merkle tree
 * @output nullifier - The nullifier value (public)
 */
template JoinSplitNullifier() {
    signal input nullifyingKey;
    signal input leafIndex;
    signal output nullifier;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== nullifyingKey;
    hasher.inputs[1] <== leafIndex;

    nullifier <== hasher.out;
}
