pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

/**
 * JoinSplit Commitment (Railgun-aligned)
 * commitment = Poseidon(npk, token, amount)
 *
 * @input npk - Note public key (Poseidon(MPK, random))
 * @input token - Token identifier (ZKBTC_TOKEN_ID)
 * @input amount - Amount in satoshis
 * @output commitment - The commitment hash
 */
template JoinSplitCommitment() {
    signal input npk;
    signal input token;
    signal input amount;
    signal output commitment;

    component hasher = Poseidon(3);
    hasher.inputs[0] <== npk;
    hasher.inputs[1] <== token;
    hasher.inputs[2] <== amount;

    commitment <== hasher.out;
}
