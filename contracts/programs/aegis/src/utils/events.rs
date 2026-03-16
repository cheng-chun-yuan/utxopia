//! Event emission utilities using sol_log_data
//!
//! Events are emitted as base64-encoded log lines ("Program data: <base64>")
//! and can be parsed by the backend indexer.
//!
//! ## Events
//!
//! - 0x02 NullifierSpent: disc(1) + nullifier_hash(32) + op_type(1) + ix_disc(1) = 35 bytes
//! - 0x03 StealthAnnouncement: disc(1) + type(1) + ephemeral(32) + amount(8) + commitment(32) + leaf_index(4) = 78 bytes
//! - 0x07 RedemptionCompleted: variable
//! - 0x08 RedemptionRequested: variable
//! - 0x0A RedemptionProcessing: disc(1) + requester(32) + amount(8) + request_id(8) + slot(4) = 53 bytes
//! - 0x0B NullifiersBatch: disc(1) + count(1) + op_type(1) + ix_disc(1) + [hash(32)] x N
//! - 0x0C AnnouncementsBatch: disc(1) + count(1) + [type(1) + ephemeral(32) + amount(8) + commitment(32) + leaf_index(4)] x N
//! - 0x0D DepositVerified: disc(1) + sweep_txid(32) + deposit_txid(32) + amount_sats(8) + leaf_index(4) = 77 bytes
//! - 0x0E UnshieldMeta: disc(1) + amount(8) + recipient(32) = 41 bytes
//! - 0x0F UtxoCreated: disc(1) + txid(32) + vout(4) + amount_sats(8) = 45 bytes
//! - 0x10 UtxoConsumed: disc(1) + txid(32) + vout(4) + amount_sats(8) = 45 bytes

use pinocchio::log::sol_log_data;

/// Event discriminator: nullifier spent
const EVENT_NULLIFIER_SPENT: u8 = 0x02;

/// Event discriminator: stealth announcement (replaces on-chain PDA)
const EVENT_STEALTH_ANNOUNCEMENT: u8 = 0x03;

/// Announcement type: deposit (plaintext amount from BTC deposit verification)
pub const ANNOUNCEMENT_TYPE_DEPOSIT: u8 = 0;

/// Announcement type: transfer (XOR-encrypted amount from JoinSplit transact)
pub const ANNOUNCEMENT_TYPE_TRANSFER: u8 = 1;

/// Event discriminator: redemption completed (PDA about to close)
const EVENT_REDEMPTION_COMPLETED: u8 = 0x07;

/// Event discriminator: redemption requested (PDA created)
const EVENT_REDEMPTION_REQUESTED: u8 = 0x08;

/// Event discriminator: redemption marked as processing
const EVENT_REDEMPTION_PROCESSING: u8 = 0x0A;

/// Event discriminator: batched nullifiers spent
const EVENT_NULLIFIERS_BATCH: u8 = 0x0B;

/// Event discriminator: batched stealth announcements
const EVENT_ANNOUNCEMENTS_BATCH: u8 = 0x0C;

/// Event discriminator: deposit verified via SPV (carries BTC txids + amount)
const EVENT_DEPOSIT_VERIFIED: u8 = 0x0D;

/// Event discriminator: unshield/redeem metadata (amount + recipient)
const EVENT_UNSHIELD_META: u8 = 0x0E;

/// Event discriminator: UTXO created (deposit or change)
const EVENT_UTXO_CREATED: u8 = 0x0F;

/// Event discriminator: UTXO consumed (spent in withdrawal)
const EVENT_UTXO_CONSUMED: u8 = 0x10;

/// Max batch items for stack-allocated buffer (MAX_SAFE_JOINSPLIT_SIZE = 14)
const MAX_BATCH: usize = 14;

/// Emit when a nullifier is spent.
///
/// Layout: disc(1) + nullifier_hash(32) + op_type(1) + ix_disc(1) = 35 bytes
pub fn emit_nullifier_spent(
    nullifier_hash: &[u8; 32],
    operation_type: u8,
    instruction_disc: u8,
) {
    let disc = [EVENT_NULLIFIER_SPENT];
    let op = [operation_type];
    let ix = [instruction_disc];
    sol_log_data(&[&disc, nullifier_hash.as_ref(), &op, &ix]);
}

/// Emit a stealth announcement with token_id.
///
/// Layout: disc(1) + type(1) + ephemeral_pub(32) + encrypted_amount(8)
///         + commitment(32) + leaf_index(4) + token_id(32) = 110 bytes
pub fn emit_stealth_announcement(
    announcement_type: u8,
    ephemeral_pub: &[u8; 32],
    encrypted_amount: &[u8; 8],
    commitment: &[u8; 32],
    leaf_index: u32,
    token_id: &[u8; 32],
) {
    let disc = [EVENT_STEALTH_ANNOUNCEMENT];
    let atype = [announcement_type];
    let li = leaf_index.to_le_bytes();
    sol_log_data(&[&disc, &atype, ephemeral_pub, encrypted_amount, commitment, &li, token_id]);
}

/// Emit when a redemption is completed (before PDA is closed).
///
/// Layout: disc(1) + requester(32) + amount_sats(8) + actual_received(8) + service_fee(8)
///         + request_id(8) + btc_txid(32) + btc_script_len(1) + btc_script(var)
/// = 114 + btc_script_len bytes
///
/// Trustless accounting:
///   miner_fee        = total_input_sats - sum(tx_outputs)  [computed on-chain from raw BTC tx]
///   burn_amount      = actual_received + miner_fee          [BTC that left the pool]
///   protocol_revenue = service_fee - miner_fee              [net profit kept in vault]
pub fn emit_redemption_completed(
    requester: &[u8; 32],
    amount_sats: u64,
    actual_received: u64,
    service_fee: u64,
    request_id: u64,
    btc_txid: &[u8; 32],
    burn_amount: u64,
    protocol_revenue: u64,
    btc_script: &[u8],
) {
    let disc = [EVENT_REDEMPTION_COMPLETED];
    let amt = amount_sats.to_le_bytes();
    let recv = actual_received.to_le_bytes();
    let sfee = service_fee.to_le_bytes();
    let rid = request_id.to_le_bytes();
    let burn_bytes = burn_amount.to_le_bytes();
    let proto_bytes = protocol_revenue.to_le_bytes();
    let script_len = [btc_script.len() as u8];
    sol_log_data(&[&disc, requester, &amt, &recv, &sfee, &rid, btc_txid, &burn_bytes, &proto_bytes, &script_len, btc_script]);
}

/// Emit when a redemption request is created (PDA initialized).
///
/// Layout: disc(1) + requester(32) + amount_sats(8) + request_id(8)
///         + service_fee_base(8) + service_fee_bps(2)
///         + btc_script_len(1) + btc_script(var)
pub fn emit_redemption_requested(
    requester: &[u8; 32],
    amount_sats: u64,
    request_id: u64,
    service_fee_base: u64,
    service_fee_bps: u16,
    btc_script: &[u8],
) {
    let disc = [EVENT_REDEMPTION_REQUESTED];
    let amt = amount_sats.to_le_bytes();
    let rid = request_id.to_le_bytes();
    let sfb = service_fee_base.to_le_bytes();
    let sbps = service_fee_bps.to_le_bytes();
    let script_len = [btc_script.len() as u8];
    sol_log_data(&[&disc, requester, &amt, &rid, &sfb, &sbps, &script_len, btc_script]);
}

/// Emit when a redemption transitions to Processing state.
///
/// Layout: disc(1) + requester(32) + amount_sats(8) + request_id(8) + processing_slot(4)
pub fn emit_redemption_processing(
    requester: &[u8; 32],
    amount_sats: u64,
    request_id: u64,
    processing_slot: u32,
) {
    let disc = [EVENT_REDEMPTION_PROCESSING];
    let amt = amount_sats.to_le_bytes();
    let rid = request_id.to_le_bytes();
    let slot = processing_slot.to_le_bytes();
    sol_log_data(&[&disc, requester, &amt, &rid, &slot]);
}

/// Emit a batch of nullifier spent events in a single sol_log_data call.
///
/// Layout: disc(1) + count(1) + op_type(1) + ix_disc(1) + [nullifier_hash(32)] x count
pub fn emit_nullifiers_batch(
    nullifiers: &[&[u8; 32]],
    operation_type: u8,
    instruction_disc: u8,
) {
    // For single nullifier, use the non-batch version (simpler parsing)
    if nullifiers.len() == 1 {
        emit_nullifier_spent(nullifiers[0], operation_type, instruction_disc);
        return;
    }

    let disc = [EVENT_NULLIFIERS_BATCH];
    let count = [nullifiers.len() as u8];
    let op = [operation_type];
    let ix = [instruction_disc];

    // Build slice array: disc + count + op_type + ix_disc + N hashes
    // Max slices = 4 + MAX_BATCH = 18
    let mut slices: [&[u8]; 4 + MAX_BATCH] = [&[0u8; 0]; 4 + MAX_BATCH];
    slices[0] = &disc;
    slices[1] = &count;
    slices[2] = &op;
    slices[3] = &ix;
    let n = nullifiers.len().min(MAX_BATCH);
    for i in 0..n {
        slices[4 + i] = nullifiers[i].as_ref();
    }
    sol_log_data(&slices[..4 + n]);
}

/// Emit when a BTC deposit is SPV-verified on-chain.
///
/// Layout: disc(1) + sweep_txid(32) + deposit_txid(32) + amount_sats(8) + leaf_index(4) = 77 bytes
pub fn emit_deposit_verified(
    sweep_txid: &[u8; 32],
    deposit_txid: &[u8; 32],
    amount_sats: u64,
    leaf_index: u32,
) {
    let disc = [EVENT_DEPOSIT_VERIFIED];
    let amt = amount_sats.to_le_bytes();
    let li = leaf_index.to_le_bytes();
    sol_log_data(&[&disc, sweep_txid, deposit_txid, &amt, &li]);
}

/// Emit unshield/redeem metadata so indexer doesn't need to parse instruction data.
///
/// Layout: disc(1) + amount(8) + recipient(32) = 41 bytes
pub fn emit_unshield_meta(
    amount: u64,
    recipient: &[u8; 32],
) {
    let disc = [EVENT_UNSHIELD_META];
    let amt = amount.to_le_bytes();
    sol_log_data(&[&disc, &amt, recipient]);
}

/// Emit when a UTXO is created (deposit or change output).
///
/// Layout: disc(1) + txid(32) + vout(4) + amount_sats(8) = 45 bytes
pub fn emit_utxo_created(
    txid: &[u8; 32],
    vout: u32,
    amount_sats: u64,
) {
    let disc = [EVENT_UTXO_CREATED];
    let v = vout.to_le_bytes();
    let amt = amount_sats.to_le_bytes();
    sol_log_data(&[&disc, txid, &v, &amt]);
}

/// Emit when a UTXO is consumed (spent in a withdrawal tx).
///
/// Layout: disc(1) + txid(32) + vout(4) + amount_sats(8) = 45 bytes
pub fn emit_utxo_consumed(
    txid: &[u8; 32],
    vout: u32,
    amount_sats: u64,
) {
    let disc = [EVENT_UTXO_CONSUMED];
    let v = vout.to_le_bytes();
    let amt = amount_sats.to_le_bytes();
    sol_log_data(&[&disc, txid, &v, &amt]);
}

/// Data for a single announcement in a batch (with token_id)
pub struct AnnouncementItem<'a> {
    pub announcement_type: u8,
    pub ephemeral_pub: &'a [u8; 32],
    pub encrypted_amount: &'a [u8; 8],
    pub commitment: &'a [u8; 32],
    pub leaf_index: u32,
    pub token_id: &'a [u8; 32],
}

/// Emit a batch of stealth announcements in a single sol_log_data call.
///
/// Layout: disc(1) + count(1) + [type(1) + ephemeral(32) + amount(8) + commitment(32) + leaf_index(4) + token_id(32)] x count
/// Per-item: 109 bytes. Max payload: 2 + 14 * 109 = 1528 bytes.
pub fn emit_announcements_batch(items: &[AnnouncementItem]) {
    if items.len() == 1 {
        emit_stealth_announcement(
            items[0].announcement_type,
            items[0].ephemeral_pub,
            items[0].encrypted_amount,
            items[0].commitment,
            items[0].leaf_index,
            items[0].token_id,
        );
        return;
    }

    let n = items.len().min(MAX_BATCH);

    // Max payload: 2 + 14 * 109 = 1528 bytes — fits on stack
    let mut buf = [0u8; 2 + MAX_BATCH * 109];
    buf[0] = EVENT_ANNOUNCEMENTS_BATCH;
    buf[1] = n as u8;
    let mut offset = 2;
    for i in 0..n {
        buf[offset] = items[i].announcement_type;
        offset += 1;
        buf[offset..offset + 32].copy_from_slice(items[i].ephemeral_pub);
        offset += 32;
        buf[offset..offset + 8].copy_from_slice(items[i].encrypted_amount);
        offset += 8;
        buf[offset..offset + 32].copy_from_slice(items[i].commitment);
        offset += 32;
        let li = items[i].leaf_index.to_le_bytes();
        buf[offset..offset + 4].copy_from_slice(&li);
        offset += 4;
        buf[offset..offset + 32].copy_from_slice(items[i].token_id);
        offset += 32;
    }

    sol_log_data(&[&buf[..offset]]);
}
