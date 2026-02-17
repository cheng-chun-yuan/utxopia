pragma circom 2.1.0;

include "./lib/commitment.circom";
include "./lib/nullifier.circom";
include "./lib/merkle.circom";

/**
 * Claim Circuit
 *
 * Proves ownership of a commitment in the Merkle tree and claims it
 * to a public Solana recipient address.
 *
 * Key derivation: pub_key = BabyPbk(priv_key) (Baby Jubjub scalar mul)
 *
 * Public inputs (4):
 *   - merkle_root: Root of the commitment tree
 *   - nullifier_hash: Hash of the nullifier (prevents double-spending)
 *   - amount_pub: Claimed amount (publicly revealed)
 *   - recipient: Solana wallet address (bound to proof)
 *
 * Private inputs:
 *   - priv_key: Spending private key (Baby Jubjub scalar)
 *   - amount: Amount in satoshis
 *   - leaf_index: Position in Merkle tree
 *   - merkle_path[20]: Merkle proof siblings
 *   - path_indices[20]: Merkle proof directions
 */
template Claim() {
    // Public inputs
    signal input merkle_root;
    signal input nullifier_hash;
    signal input amount_pub;
    signal input recipient;

    // Private inputs
    signal input priv_key;
    signal input amount;
    signal input leaf_index;
    signal input merkle_path[20];
    signal input path_indices[20];

    // 1. Derive public key from private key (Baby Jubjub)
    component pubKeyDerivation = PubKeyDerivation();
    pubKeyDerivation.priv_key <== priv_key;

    // 2. Compute commitment = Poseidon(pub_key_x, amount)
    component commitment = Commitment();
    commitment.pub_key_x <== pubKeyDerivation.pub_key_x;
    commitment.amount <== amount;

    // 3. Verify Merkle proof
    component merkle = MerkleProofVerifier(20);
    merkle.leaf <== commitment.commitment;
    for (var i = 0; i < 20; i++) {
        merkle.path_elements[i] <== merkle_path[i];
        merkle.path_indices[i] <== path_indices[i];
    }
    merkle.root === merkle_root;

    // 4. Compute and verify nullifier hash
    component nullifier = Nullifier();
    nullifier.priv_key <== priv_key;
    nullifier.leaf_index <== leaf_index;
    nullifier.nullifier_hash === nullifier_hash;

    // 5. Amount must match public input
    amount === amount_pub;

    // 6. Recipient is a public input (bound to proof, no constraint needed beyond being public)
    // The on-chain program uses this to ensure the correct recipient gets the funds
}

component main {public [merkle_root, nullifier_hash, amount_pub, recipient]} = Claim();
