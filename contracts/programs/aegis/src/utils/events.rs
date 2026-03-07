//! Event emission utilities using sol_log_data
//!
//! Events are emitted as base64-encoded log lines ("Program data: <base64>")
//! and can be parsed by the backend indexer.

use pinocchio::log::sol_log_data;

/// Event discriminator: leaf inserted into commitment tree
const EVENT_LEAF_INSERTED: u8 = 0x01;

/// Event discriminator: nullifier spent
const EVENT_NULLIFIER_SPENT: u8 = 0x02;

/// Event discriminator: stealth announcement (replaces on-chain PDA)
const EVENT_STEALTH_ANNOUNCEMENT: u8 = 0x03;

/// Announcement type: deposit (plaintext amount from BTC deposit verification)
pub const ANNOUNCEMENT_TYPE_DEPOSIT: u8 = 0;

/// Announcement type: transfer (XOR-encrypted amount from JoinSplit transact)
pub const ANNOUNCEMENT_TYPE_TRANSFER: u8 = 1;

/// Emit when a commitment is inserted into the Merkle tree.
///
/// Layout: disc(1) + commitment(32) + created_at(8) = 41 bytes
pub fn emit_leaf_inserted(commitment: &[u8; 32], created_at: i64) {
    let disc = [EVENT_LEAF_INSERTED];
    let ts = created_at.to_le_bytes();
    sol_log_data(&[&disc, commitment.as_ref(), &ts]);
}

/// Emit when a nullifier is spent (audit metadata).
///
/// Layout: disc(1) + nullifier_hash(32) + op_type(1) + spent_at(8) + spent_by(32) = 74 bytes
pub fn emit_nullifier_spent(
    nullifier_hash: &[u8; 32],
    operation_type: u8,
    spent_at: i64,
    spent_by: &[u8; 32],
) {
    let disc = [EVENT_NULLIFIER_SPENT];
    let op = [operation_type];
    let ts = spent_at.to_le_bytes();
    sol_log_data(&[&disc, nullifier_hash.as_ref(), &op, &ts, spent_by.as_ref()]);
}

/// Emit a stealth announcement as a log event (replaces on-chain PDA creation).
///
/// Layout: disc(1) + type(1) + ephemeral_pub(32) + encrypted_amount(8) + commitment(32) + leaf_index(4) = 78 bytes
pub fn emit_stealth_announcement(
    announcement_type: u8,
    ephemeral_pub: &[u8; 32],
    encrypted_amount: &[u8; 8],
    commitment: &[u8; 32],
    leaf_index: u32,
) {
    let disc = [EVENT_STEALTH_ANNOUNCEMENT];
    let atype = [announcement_type];
    let li = leaf_index.to_le_bytes();
    sol_log_data(&[&disc, &atype, ephemeral_pub, encrypted_amount, commitment, &li]);
}
