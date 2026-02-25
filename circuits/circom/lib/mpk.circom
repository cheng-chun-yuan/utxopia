pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

/**
 * Master Public Key (Railgun-aligned 3-key model)
 * MPK = Poseidon(publicKey.x, publicKey.y, nullifyingKey)
 *
 * The MPK binds the spending key to the nullifying key,
 * preventing key-separation attacks.
 *
 * @input pkX - Baby Jubjub public key x-coordinate
 * @input pkY - Baby Jubjub public key y-coordinate
 * @input nullifyingKey - Nullifying key (derived from wallet signature)
 * @output mpk - Master public key hash
 */
template MasterPublicKey() {
    signal input pkX;
    signal input pkY;
    signal input nullifyingKey;
    signal output mpk;

    component hasher = Poseidon(3);
    hasher.inputs[0] <== pkX;
    hasher.inputs[1] <== pkY;
    hasher.inputs[2] <== nullifyingKey;

    mpk <== hasher.out;
}
