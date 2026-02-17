pragma circom 2.1.0;

include "./lib/commitment.circom";
include "./lib/nullifier.circom";
include "./lib/merkle.circom";

/**
 * Spend Partial Public Circuit
 *
 * Partially claims from a commitment: public amount + private change.
 * Amount conservation: input_amount == public_amount + change_amount
 *
 * All public keys are derived in-circuit from private keys via BabyPbk().
 *
 * Public inputs (5):
 *   - merkle_root
 *   - nullifier_hash
 *   - public_amount (revealed amount to claim)
 *   - change_commitment (private change note)
 *   - recipient (Solana wallet bound to proof)
 */
template SpendPartialPublic() {
    // Public inputs
    signal input merkle_root;
    signal input nullifier_hash;
    signal input public_amount;
    signal input change_commitment;
    signal input recipient;

    // Private inputs
    signal input priv_key;
    signal input amount;
    signal input leaf_index;
    signal input merkle_path[20];
    signal input path_indices[20];
    signal input change_priv_key;
    signal input change_amount;

    // 1. Derive input public key
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
    amount === public_amount + change_amount;

    // 5. Derive change public key and verify change commitment
    component changePubKey = PubKeyDerivation();
    changePubKey.priv_key <== change_priv_key;

    component change = Commitment();
    change.pub_key_x <== changePubKey.pub_key_x;
    change.amount <== change_amount;
    change.commitment === change_commitment;
}

component main {public [merkle_root, nullifier_hash, public_amount, change_commitment, recipient]} = SpendPartialPublic();
