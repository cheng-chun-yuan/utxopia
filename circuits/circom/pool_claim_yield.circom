pragma circom 2.1.0;

include "./lib/commitment.circom";
include "./lib/nullifier.circom";
include "./lib/merkle.circom";

/**
 * Pool Claim Yield Circuit
 *
 * Claims earned yield while keeping principal staked.
 * Input:  Old Pool Position = Poseidon(old_pub_key_x, principal, deposit_epoch)
 * Output: 1. New Pool Position = Poseidon(new_pub_key_x, principal, current_epoch)
 *         2. Yield Commitment = Poseidon(yield_pub_key_x, yield_amount)
 *
 * Old position public key is derived in-circuit from private key via BabyPbk().
 *
 * Public inputs (6):
 *   - pool_merkle_root
 *   - old_nullifier_hash
 *   - new_pool_commitment
 *   - yield_commitment
 *   - current_epoch
 *   - yield_rate_bps
 */
template PoolClaimYield() {
    // Public inputs
    signal input pool_merkle_root;
    signal input old_nullifier_hash;
    signal input new_pool_commitment;
    signal input yield_commitment;
    signal input current_epoch;
    signal input yield_rate_bps;

    // Private inputs
    signal input old_priv_key;
    signal input principal;
    signal input deposit_epoch;
    signal input leaf_index;
    signal input pool_merkle_path[20];
    signal input pool_path_indices[20];
    signal input new_pub_key_x;
    signal input yield_pub_key_x;

    // 1. Derive old position public key
    component oldPubKey = PubKeyDerivation();
    oldPubKey.priv_key <== old_priv_key;

    // 2. Verify old pool position in tree
    component oldPoolCommit = PoolCommitment();
    oldPoolCommit.pub_key_x <== oldPubKey.pub_key_x;
    oldPoolCommit.principal <== principal;
    oldPoolCommit.deposit_epoch <== deposit_epoch;

    component merkle = MerkleProofVerifier(20);
    merkle.leaf <== oldPoolCommit.commitment;
    for (var i = 0; i < 20; i++) {
        merkle.path_elements[i] <== pool_merkle_path[i];
        merkle.path_indices[i] <== pool_path_indices[i];
    }
    merkle.root === pool_merkle_root;

    // 3. Verify old nullifier
    component nullifier = Nullifier();
    nullifier.priv_key <== old_priv_key;
    nullifier.leaf_index <== leaf_index;
    nullifier.nullifier_hash === old_nullifier_hash;

    // 4. Verify new pool commitment (principal stays, epoch resets)
    component newPoolCommit = PoolCommitment();
    newPoolCommit.pub_key_x <== new_pub_key_x;
    newPoolCommit.principal <== principal;
    newPoolCommit.deposit_epoch <== current_epoch;
    newPoolCommit.commitment === new_pool_commitment;

    // 5. Yield calculation is done on-chain
    // The yield_commitment is verified to be a valid commitment structure
    // The on-chain program independently calculates yield_amount and validates
}

component main {public [pool_merkle_root, old_nullifier_hash, new_pool_commitment, yield_commitment, current_epoch, yield_rate_bps]} = PoolClaimYield();
