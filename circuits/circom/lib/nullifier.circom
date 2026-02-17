pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/babyjub.circom";

/**
 * Nullifier derivation
 * nullifier = Poseidon(priv_key, leaf_index)
 * nullifier_hash = Poseidon(nullifier)
 *
 * Compatible with SDK's computeNullifierSync() and hashNullifierSync()
 */
template Nullifier() {
    signal input priv_key;
    signal input leaf_index;
    signal output nullifier_hash;

    // Step 1: nullifier = Poseidon(priv_key, leaf_index)
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== priv_key;
    nullifierHasher.inputs[1] <== leaf_index;

    // Step 2: nullifier_hash = Poseidon(nullifier)
    component hashHasher = Poseidon(1);
    hashHasher.inputs[0] <== nullifierHasher.out;

    nullifier_hash <== hashHasher.out;
}

/**
 * Public key derivation from private key using Baby Jubjub scalar multiplication
 *
 * Uses circomlib's BabyPbk() which computes: pubKey = privKey * BASE8
 * This matches the SDK's babyJubMul(privKey, BABYJUB_BASE8)
 */
template PubKeyDerivation() {
    signal input priv_key;
    signal output pub_key_x;
    signal output pub_key_y;

    component pubKey = BabyPbk();
    pubKey.in <== priv_key;

    pub_key_x <== pubKey.Ax;
    pub_key_y <== pubKey.Ay;
}
