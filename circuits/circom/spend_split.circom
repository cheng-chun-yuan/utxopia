pragma circom 2.1.0;

include "./lib/commitment.circom";
include "./lib/nullifier.circom";
include "./lib/merkle.circom";

/**
 * Spend Split Circuit
 *
 * Splits one commitment into two output commitments.
 * Amount conservation: input_amount == output1_amount + output2_amount
 *
 * All public keys are derived in-circuit from private keys via BabyPbk().
 *
 * Public inputs (4):
 *   - merkle_root
 *   - nullifier_hash
 *   - output_commitment1
 *   - output_commitment2
 *
 * Private inputs:
 *   - priv_key, amount, leaf_index
 *   - merkle_path[20], path_indices[20]
 *   - output1_priv_key, output1_amount
 *   - output2_priv_key, output2_amount
 */
template SpendSplit() {
    // Public inputs
    signal input merkle_root;
    signal input nullifier_hash;
    signal input output_commitment1;
    signal input output_commitment2;

    // Private inputs - input note
    signal input priv_key;
    signal input amount;
    signal input leaf_index;
    signal input merkle_path[20];
    signal input path_indices[20];

    // Private inputs - output notes (private keys instead of pub_key_x)
    signal input output1_priv_key;
    signal input output1_amount;
    signal input output2_priv_key;
    signal input output2_amount;

    // 1. Derive input public key from private key
    component inputPubKey = PubKeyDerivation();
    inputPubKey.priv_key <== priv_key;

    // 2. Verify input commitment in tree
    component inputCommitment = Commitment();
    inputCommitment.pub_key_x <== inputPubKey.pub_key_x;
    inputCommitment.amount <== amount;

    component merkle = MerkleProofVerifier(20);
    merkle.leaf <== inputCommitment.commitment;
    for (var i = 0; i < 20; i++) {
        merkle.path_elements[i] <== merkle_path[i];
        merkle.path_indices[i] <== path_indices[i];
    }
    merkle.root === merkle_root;

    // 3. Verify nullifier
    component nullifier = Nullifier();
    nullifier.priv_key <== priv_key;
    nullifier.leaf_index <== leaf_index;
    nullifier.nullifier_hash === nullifier_hash;

    // 4. Amount conservation
    amount === output1_amount + output2_amount;

    // 5. Derive output public keys and verify commitments
    component out1PubKey = PubKeyDerivation();
    out1PubKey.priv_key <== output1_priv_key;

    component out1 = Commitment();
    out1.pub_key_x <== out1PubKey.pub_key_x;
    out1.amount <== output1_amount;
    out1.commitment === output_commitment1;

    component out2PubKey = PubKeyDerivation();
    out2PubKey.priv_key <== output2_priv_key;

    component out2 = Commitment();
    out2.pub_key_x <== out2PubKey.pub_key_x;
    out2.amount <== output2_amount;
    out2.commitment === output_commitment2;
}

component main {public [merkle_root, nullifier_hash, output_commitment1, output_commitment2]} = SpendSplit();
