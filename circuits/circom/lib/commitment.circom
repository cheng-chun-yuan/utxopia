pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";

/**
 * Unified Commitment
 * commitment = Poseidon(pub_key_x, amount)
 *
 * Compatible with SDK's computeUnifiedCommitmentSync()
 */
template Commitment() {
    signal input pub_key_x;
    signal input amount;
    signal output commitment;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== pub_key_x;
    hasher.inputs[1] <== amount;

    commitment <== hasher.out;
}

/**
 * Pool Commitment
 * commitment = Poseidon(pub_key_x, principal, deposit_epoch)
 *
 * Compatible with SDK's computePoolCommitmentSync()
 */
template PoolCommitment() {
    signal input pub_key_x;
    signal input principal;
    signal input deposit_epoch;
    signal output commitment;

    component hasher = Poseidon(3);
    hasher.inputs[0] <== pub_key_x;
    hasher.inputs[1] <== principal;
    hasher.inputs[2] <== deposit_epoch;

    commitment <== hasher.out;
}
