pragma circom 2.1.0;

include "./lib/commitment.circom";
include "./lib/nullifier.circom";
include "./lib/merkle.circom";

/**
 * Pool Deposit Circuit
 *
 * Spends a unified commitment and creates a pool position.
 * Input:  Unified Commitment = Poseidon(pub_key_x, amount)
 * Output: Pool Position = Poseidon(pool_pub_key_x, principal, deposit_epoch)
 *
 * Input public key is derived in-circuit from private key via BabyPbk().
 *
 * Public inputs (4):
 *   - input_merkle_root
 *   - input_nullifier_hash
 *   - pool_commitment
 *   - deposit_epoch
 */
template PoolDeposit() {
    // Public inputs
    signal input input_merkle_root;
    signal input input_nullifier_hash;
    signal input pool_commitment;
    signal input deposit_epoch;

    // Private inputs
    signal input priv_key;
    signal input amount;
    signal input leaf_index;
    signal input input_merkle_path[20];
    signal input input_path_indices[20];
    signal input pool_pub_key_x;

    // 1. Derive input public key
    component inputPubKey = PubKeyDerivation();
    inputPubKey.priv_key <== priv_key;

    // 2. Verify input commitment in main tree
    component inputCommitment = Commitment();
    inputCommitment.pub_key_x <== inputPubKey.pub_key_x;
    inputCommitment.amount <== amount;

    component merkle = MerkleProofVerifier(20);
    merkle.leaf <== inputCommitment.commitment;
    for (var i = 0; i < 20; i++) {
        merkle.path_elements[i] <== input_merkle_path[i];
        merkle.path_indices[i] <== input_path_indices[i];
    }
    merkle.root === input_merkle_root;

    // 3. Verify nullifier
    component nullifier = Nullifier();
    nullifier.priv_key <== priv_key;
    nullifier.leaf_index <== leaf_index;
    nullifier.nullifier_hash === input_nullifier_hash;

    // 4. Verify pool commitment = Poseidon(pool_pub_key_x, amount, deposit_epoch)
    component poolCommit = PoolCommitment();
    poolCommit.pub_key_x <== pool_pub_key_x;
    poolCommit.principal <== amount;
    poolCommit.deposit_epoch <== deposit_epoch;
    poolCommit.commitment === pool_commitment;
}

component main {public [input_merkle_root, input_nullifier_hash, pool_commitment, deposit_epoch]} = PoolDeposit();
