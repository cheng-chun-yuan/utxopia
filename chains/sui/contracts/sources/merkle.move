module utxopia::merkle {
    use utxopia::errors;
    use utxopia::events;
    use utxopia::pool::{Self, Pool};

    public fun insert_commitment(pool: &mut Pool, commitment: vector<u8>, new_root: vector<u8>) {
        pool::assert_not_paused(pool);
        assert!(vector::length(&commitment) > 0, errors::invalid_commitment());

        let leaf_index = pool::next_leaf_index(pool);
        events::commitment_inserted(pool::pool_id(pool), leaf_index, commitment);
        pool::increment_leaf_index(pool);
        pool::set_latest_root(pool, new_root);
    }
}
