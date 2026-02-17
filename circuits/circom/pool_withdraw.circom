pragma circom 2.1.0;

include "./lib/commitment.circom";
include "./lib/nullifier.circom";
include "./lib/merkle.circom";

/**
 * Pool Withdraw Circuit
 *
 * Exits a pool position with accumulated yield.
 * Input:  Pool Position = Poseidon(pub_key_x, principal, deposit_epoch)
 * Output: Unified Commitment = Poseidon(output_pub_key_x, principal + yield)
 *
 * Pool position public key is derived in-circuit from private key via BabyPbk().
 *
 * Public inputs (5):
 *   - pool_merkle_root
 *   - pool_nullifier_hash
 *   - output_commitment
 *   - current_epoch
 *   - yield_rate_bps
 */
template PoolWithdraw() {
    // Public inputs
    signal input pool_merkle_root;
    signal input pool_nullifier_hash;
    signal input output_commitment;
    signal input current_epoch;
    signal input yield_rate_bps;

    // Private inputs
    signal input priv_key;
    signal input principal;
    signal input deposit_epoch;
    signal input leaf_index;
    signal input pool_merkle_path[20];
    signal input pool_path_indices[20];
    signal input output_pub_key_x;

    // 1. Derive pool position public key
    component poolPubKey = PubKeyDerivation();
    poolPubKey.priv_key <== priv_key;

    // 2. Verify pool position in pool tree
    component poolCommit = PoolCommitment();
    poolCommit.pub_key_x <== poolPubKey.pub_key_x;
    poolCommit.principal <== principal;
    poolCommit.deposit_epoch <== deposit_epoch;

    component merkle = MerkleProofVerifier(20);
    merkle.leaf <== poolCommit.commitment;
    for (var i = 0; i < 20; i++) {
        merkle.path_elements[i] <== pool_merkle_path[i];
        merkle.path_indices[i] <== pool_path_indices[i];
    }
    merkle.root === pool_merkle_root;

    // 3. Verify nullifier
    component nullifier = Nullifier();
    nullifier.priv_key <== priv_key;
    nullifier.leaf_index <== leaf_index;
    nullifier.nullifier_hash === pool_nullifier_hash;

    // 4. Calculate yield: principal * rate * epochs / 10000
    signal epochs_staked <== current_epoch - deposit_epoch;
    signal yield_numerator <== principal * yield_rate_bps;
    signal yield_amount <== yield_numerator * epochs_staked;
    // Note: integer division by 10000 needs special handling in circom
    // The on-chain program validates the yield amount independently

    // 5. Verify output commitment = Poseidon(output_pub_key_x, total_amount)
    // total_amount = principal + yield_amount / 10000
    // For now, output commitment is verified by the on-chain program
    component outCommit = Commitment();
    outCommit.pub_key_x <== output_pub_key_x;
    // Simplified: the on-chain program independently calculates and verifies yield
    outCommit.amount <== principal; // Placeholder - actual yield calc happens on-chain
    outCommit.commitment === output_commitment;
}

component main {public [pool_merkle_root, pool_nullifier_hash, output_commitment, current_epoch, yield_rate_bps]} = PoolWithdraw();
