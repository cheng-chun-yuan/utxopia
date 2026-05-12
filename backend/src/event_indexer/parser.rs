//! Event parser for UTXOpia sol_log_data events
//!
//! Matches discriminators from contracts/programs/utxopia/src/utils/events.rs:
//! - 0x02 = NullifierSpent (nullifier_hash + op_type + ix_disc)
//! - 0x03 = StealthAnnouncement (type + ephemeral + amount + commitment + leaf_index + token_id)
//! - 0x07 = RedemptionCompleted
//! - 0x08 = RedemptionRequested
//! - 0x0A = RedemptionProcessing
//! - 0x0B = NullifiersBatch (count + op_type + ix_disc + [hash] x N)
//! - 0x0C = AnnouncementsBatch (count + [type + ephemeral + amount + commitment + leaf_index] x N)
//! - 0x0D = DepositVerified (sweep_txid + deposit_txid + amount_sats + leaf_index)
//! - 0x0E = UnshieldMeta (amount + recipient + token_id)
//! - 0x11 = ShieldMeta (gross_amount + fee + token_id)

use base64::Engine;

/// Event discriminators matching on-chain events.rs
const EVENT_NULLIFIER_SPENT: u8 = 0x02;
const EVENT_STEALTH_ANNOUNCEMENT: u8 = 0x03;
const EVENT_REDEMPTION_COMPLETED: u8 = 0x07;
const EVENT_REDEMPTION_REQUESTED: u8 = 0x08;
const EVENT_REDEMPTION_PROCESSING: u8 = 0x0A;
const EVENT_NULLIFIERS_BATCH: u8 = 0x0B;
const EVENT_ANNOUNCEMENTS_BATCH: u8 = 0x0C;
const EVENT_DEPOSIT_VERIFIED: u8 = 0x0D;
const EVENT_UNSHIELD_META: u8 = 0x0E;
const EVENT_UTXO_CREATED: u8 = 0x0F;
const EVENT_UTXO_CONSUMED: u8 = 0x10;
const EVENT_SHIELD_META: u8 = 0x11;

/// Parsed nullifier spent event
#[derive(Debug, Clone)]
pub struct NullifierSpentEvent {
    pub nullifier_hash: [u8; 32],
    pub operation_type: u8,
    /// Instruction discriminator that spent this nullifier (0 if from old contract)
    pub instruction_disc: u8,
}

/// Parsed deposit verified event (BTC deposit SPV-verified on-chain)
#[derive(Debug, Clone)]
pub struct DepositVerifiedEvent {
    pub sweep_txid: [u8; 32],
    pub deposit_txid: [u8; 32],
    pub amount_sats: u64,
    pub leaf_index: u32,
    /// Original BTC deposit amount (what user sent to taproot, before miner fee)
    pub original_amount: u64,
}

/// Parsed unshield/redeem metadata event
#[derive(Debug, Clone)]
pub struct UnshieldMetaEvent {
    /// Gross amount (before fee)
    pub amount: u64,
    /// Protocol fee deducted
    pub fee: u64,
    /// Net payout to user
    pub payout: u64,
    pub recipient: [u8; 32],
    pub token_id: [u8; 32],
}

/// Parsed redemption completed event
#[derive(Debug, Clone, serde::Serialize)]
pub struct RedemptionCompletedEvent {
    pub requester: [u8; 32],
    pub amount_sats: u64,
    /// Actual BTC amount received by user (net of all fees)
    pub actual_received: u64,
    /// Service fee locked at request time
    pub service_fee: u64,
    pub request_id: u64,
    pub btc_txid: [u8; 32],
    /// zkBTC actually burned from vault (= actual_received + miner_fee)
    pub burn_amount: u64,
    /// Protocol revenue kept in vault (= service_fee - miner_fee)
    pub protocol_revenue: u64,
    pub btc_script: Vec<u8>,
}

/// Parsed redemption requested event
#[derive(Debug, Clone, serde::Serialize)]
pub struct RedemptionRequestedEvent {
    pub requester: [u8; 32],
    pub amount_sats: u64,
    pub request_id: u64,
    pub service_fee_base: u64,
    pub service_fee_bps: u16,
    pub btc_script: Vec<u8>,
}

/// Parsed redemption processing event
#[derive(Debug, Clone, serde::Serialize)]
pub struct RedemptionProcessingEvent {
    pub requester: [u8; 32],
    pub amount_sats: u64,
    pub request_id: u64,
    pub processing_slot: u32,
}

/// Parsed stealth announcement event
#[derive(Debug, Clone, serde::Serialize)]
pub struct StealthAnnouncementEvent {
    pub announcement_type: u8,
    pub ephemeral_pub: [u8; 32],
    pub encrypted_amount: [u8; 8],
    pub commitment: [u8; 32],
    pub leaf_index: u32,
    /// Token ID from on-chain event (32 bytes)
    pub token_id: [u8; 32],
}

/// Parsed shield metadata event (gross amount + fee for deposits)
#[derive(Debug, Clone, serde::Serialize)]
pub struct ShieldMetaEvent {
    pub gross_amount: u64,
    pub fee: u64,
    pub token_id: [u8; 32],
}

/// Parsed UTXO event (created or consumed)
#[derive(Debug, Clone, serde::Serialize)]
pub struct UtxoEvent {
    pub txid: [u8; 32],
    pub vout: u32,
    pub amount_sats: u64,
}

/// Union of all program events
#[derive(Debug, Clone)]
pub enum ProgramEvent {
    NullifierSpent(NullifierSpentEvent),
    StealthAnnouncement(StealthAnnouncementEvent),
    RedemptionCompleted(RedemptionCompletedEvent),
    RedemptionRequested(RedemptionRequestedEvent),
    RedemptionProcessing(RedemptionProcessingEvent),
    DepositVerified(DepositVerifiedEvent),
    UnshieldMeta(UnshieldMetaEvent),
    UtxoCreated(UtxoEvent),
    UtxoConsumed(UtxoEvent),
    ShieldMeta(ShieldMetaEvent),
}

/// Parse program events from transaction log messages.
///
/// sol_log_data emits log lines in the format:
///   "Program data: <base64_segment1> <base64_segment2> ..."
///
/// Each segment is a separate slice passed to sol_log_data.
pub fn parse_program_events(logs: &[String]) -> Vec<ProgramEvent> {
    let mut events = Vec::new();
    let prefix = "Program data: ";

    for line in logs {
        if !line.starts_with(prefix) {
            continue;
        }

        let data_part = &line[prefix.len()..];
        let segments: Vec<Vec<u8>> = data_part
            .split(' ')
            .filter_map(|s| {
                base64::engine::general_purpose::STANDARD.decode(s).ok()
            })
            .collect();

        if segments.is_empty() {
            continue;
        }

        // Some events are emitted as a single flat segment
        if segments.len() == 1 && segments[0].len() > 1 {
            let disc = segments[0][0];
            match disc {
                EVENT_ANNOUNCEMENTS_BATCH => {
                    let batch = parse_announcements_batch(&segments[0]);
                    events.extend(batch.into_iter().map(ProgramEvent::StealthAnnouncement));
                    continue;
                }
                EVENT_NULLIFIERS_BATCH => {
                    let batch = parse_nullifiers_batch(&segments[0]);
                    events.extend(batch.into_iter().map(ProgramEvent::NullifierSpent));
                    continue;
                }
                EVENT_DEPOSIT_VERIFIED => {
                    if let Some(event) = parse_deposit_verified_flat(&segments[0]) {
                        events.push(ProgramEvent::DepositVerified(event));
                    }
                    continue;
                }
                EVENT_UNSHIELD_META => {
                    if let Some(event) = parse_unshield_meta_flat(&segments[0]) {
                        events.push(ProgramEvent::UnshieldMeta(event));
                    }
                    continue;
                }
                EVENT_UTXO_CREATED => {
                    if let Some(event) = parse_utxo_event_flat(&segments[0]) {
                        events.push(ProgramEvent::UtxoCreated(event));
                    }
                    continue;
                }
                EVENT_UTXO_CONSUMED => {
                    if let Some(event) = parse_utxo_event_flat(&segments[0]) {
                        events.push(ProgramEvent::UtxoConsumed(event));
                    }
                    continue;
                }
                EVENT_SHIELD_META => {
                    if let Some(event) = parse_shield_meta_flat(&segments[0]) {
                        events.push(ProgramEvent::ShieldMeta(event));
                    }
                    continue;
                }
                _ => {}
            }
        }

        if segments[0].len() != 1 {
            continue;
        }

        let disc = segments[0][0];

        match disc {
            EVENT_NULLIFIERS_BATCH => {
                // Multi-segment batch: disc(1) + count(1) + op_type(1) + [hash(32)] x N
                let batch = parse_nullifiers_batch_segments(&segments);
                events.extend(batch.into_iter().map(ProgramEvent::NullifierSpent));
            }
            EVENT_NULLIFIER_SPENT => {
                if let Some(event) = parse_nullifier_spent(&segments) {
                    events.push(ProgramEvent::NullifierSpent(event));
                }
            }
            EVENT_STEALTH_ANNOUNCEMENT => {
                if let Some(event) = parse_stealth_announcement(&segments) {
                    events.push(ProgramEvent::StealthAnnouncement(event));
                }
            }
            EVENT_REDEMPTION_COMPLETED => {
                if let Some(event) = parse_redemption_completed(&segments) {
                    events.push(ProgramEvent::RedemptionCompleted(event));
                }
            }
            EVENT_REDEMPTION_REQUESTED => {
                if let Some(event) = parse_redemption_requested(&segments) {
                    events.push(ProgramEvent::RedemptionRequested(event));
                }
            }
            EVENT_REDEMPTION_PROCESSING => {
                if let Some(event) = parse_redemption_processing(&segments) {
                    events.push(ProgramEvent::RedemptionProcessing(event));
                }
            }
            EVENT_DEPOSIT_VERIFIED => {
                if let Some(event) = parse_deposit_verified(&segments) {
                    events.push(ProgramEvent::DepositVerified(event));
                }
            }
            EVENT_UNSHIELD_META => {
                if let Some(event) = parse_unshield_meta(&segments) {
                    events.push(ProgramEvent::UnshieldMeta(event));
                }
            }
            EVENT_UTXO_CREATED => {
                if let Some(event) = parse_utxo_event(&segments) {
                    events.push(ProgramEvent::UtxoCreated(event));
                }
            }
            EVENT_UTXO_CONSUMED => {
                if let Some(event) = parse_utxo_event(&segments) {
                    events.push(ProgramEvent::UtxoConsumed(event));
                }
            }
            EVENT_SHIELD_META => {
                if let Some(event) = parse_shield_meta(&segments) {
                    events.push(ProgramEvent::ShieldMeta(event));
                }
            }
            _ => {}
        }
    }

    events
}

/// Parse nullifier event(s) from either single or batch format.
///
/// Single: disc(1) + hash(32) + op_type(1) + [ix_disc(1)]
/// Batch flat: disc(1) + count(1) + op_type(1) + ix_disc(1) + [hash(32)] x N
/// Batch segments: [disc, count, op_type, [ix_disc], hash1, hash2, ...]
fn parse_nullifier_spent(segments: &[Vec<u8>]) -> Option<NullifierSpentEvent> {
    if segments.len() < 3 || segments[1].len() != 32 || segments[2].len() != 1 {
        return None;
    }
    let mut nullifier_hash = [0u8; 32];
    nullifier_hash.copy_from_slice(&segments[1]);
    let instruction_disc = segments.get(3)
        .filter(|s| s.len() == 1)
        .map(|s| s[0])
        .unwrap_or(0);
    Some(NullifierSpentEvent { nullifier_hash, operation_type: segments[2][0], instruction_disc })
}

/// Parse nullifier batch — handles both flat (single segment) and multi-segment formats.
fn parse_nullifiers_batch(data: &[u8]) -> Vec<NullifierSpentEvent> {
    if data.len() < 4 { return Vec::new(); }
    let count = data[1] as usize;
    let op_type = data[2];
    let ix_disc = data[3];
    if data.len() < 4 + count * 32 { return Vec::new(); }
    (0..count).map(|i| {
        let offset = 4 + i * 32;
        let mut h = [0u8; 32];
        h.copy_from_slice(&data[offset..offset + 32]);
        NullifierSpentEvent { nullifier_hash: h, operation_type: op_type, instruction_disc: ix_disc }
    }).collect()
}

fn parse_nullifiers_batch_segments(segments: &[Vec<u8>]) -> Vec<NullifierSpentEvent> {
    if segments.len() < 4 || segments[1].len() != 1 || segments[2].len() != 1 { return Vec::new(); }
    let count = segments[1][0] as usize;
    let op_type = segments[2][0];
    let (ix_disc, hash_start) = if segments.get(3).map(|s| s.len()) == Some(1) {
        (segments[3][0], 4)
    } else {
        (0, 3)
    };
    (0..count).filter_map(|i| {
        let idx = hash_start + i;
        let seg = segments.get(idx)?;
        if seg.len() != 32 { return None; }
        let mut h = [0u8; 32];
        h.copy_from_slice(seg);
        Some(NullifierSpentEvent { nullifier_hash: h, operation_type: op_type, instruction_disc: ix_disc })
    }).collect()
}

/// Parse batched announcements (v2): disc(1) + count(1) + [type(1) + ephemeral(32) + amount(8) + commitment(32) + leaf_index(4) + token_id(32)] x N
fn parse_announcements_batch(data: &[u8]) -> Vec<StealthAnnouncementEvent> {
    if data.len() < 2 {
        return Vec::new();
    }

    let count = data[1] as usize;
    let item_size = 1 + 32 + 8 + 32 + 4 + 32; // 109 bytes per item (v2 with token_id)
    let expected_len = 2 + count * item_size;
    if data.len() < expected_len {
        return Vec::new();
    }

    let mut events = Vec::with_capacity(count);
    for i in 0..count {
        let offset = 2 + i * item_size;
        let announcement_type = data[offset];

        let mut ephemeral_pub = [0u8; 32];
        ephemeral_pub.copy_from_slice(&data[offset + 1..offset + 33]);

        let mut encrypted_amount = [0u8; 8];
        encrypted_amount.copy_from_slice(&data[offset + 33..offset + 41]);

        let mut commitment = [0u8; 32];
        commitment.copy_from_slice(&data[offset + 41..offset + 73]);

        let leaf_index = u32::from_le_bytes(data[offset + 73..offset + 77].try_into().unwrap());

        let mut token_id = [0u8; 32];
        token_id.copy_from_slice(&data[offset + 77..offset + 109]);

        events.push(StealthAnnouncementEvent {
            announcement_type,
            ephemeral_pub,
            encrypted_amount,
            commitment,
            leaf_index,
            token_id,
        });
    }

    events
}

fn parse_stealth_announcement(segments: &[Vec<u8>]) -> Option<StealthAnnouncementEvent> {
    // v1: disc(1) + type(1) + ephemeral_pub(32) + encrypted_amount(8) + commitment(32) + leaf_index(4) = 6 segments
    // v2: + token_id(32) = 7 segments
    if segments.len() < 6 {
        return None;
    }
    if segments[1].len() != 1 || segments[2].len() != 32 || segments[3].len() != 8
        || segments[4].len() != 32 || segments[5].len() != 4
    {
        return None;
    }

    let mut ephemeral_pub = [0u8; 32];
    ephemeral_pub.copy_from_slice(&segments[2]);
    let mut encrypted_amount = [0u8; 8];
    encrypted_amount.copy_from_slice(&segments[3]);
    let mut commitment = [0u8; 32];
    commitment.copy_from_slice(&segments[4]);
    let leaf_index = u32::from_le_bytes(segments[5][..4].try_into().ok()?);

    // token_id at segment 6 (required)
    if segments.len() < 7 || segments[6].len() != 32 {
        return None;
    }
    let mut token_id = [0u8; 32];
    token_id.copy_from_slice(&segments[6]);

    Some(StealthAnnouncementEvent {
        announcement_type: segments[1][0],
        ephemeral_pub,
        encrypted_amount,
        commitment,
        leaf_index,
        token_id,
    })
}

/// Extract a fixed-size array from a segment
fn read_bytes32(seg: &[u8]) -> Option<[u8; 32]> {
    seg.try_into().ok()
}

/// Extract a u64 from an 8-byte segment
fn read_u64(seg: &[u8]) -> Option<u64> {
    Some(u64::from_le_bytes(seg[..8].try_into().ok()?))
}

/// Extract script from (script_len_segment, script_segment)
fn read_script(len_seg: &[u8], data_seg: &[u8]) -> Vec<u8> {
    let script_len = len_seg[0] as usize;
    if script_len > 0 && data_seg.len() >= script_len {
        data_seg[..script_len].to_vec()
    } else {
        data_seg.to_vec()
    }
}

fn parse_redemption_completed(segments: &[Vec<u8>]) -> Option<RedemptionCompletedEvent> {
    // New layout (v2): disc(1) + requester(32) + amount_sats(8) + actual_received(8) + service_fee(8)
    //   + request_id(8) + btc_txid(32) + burn_amount(8) + protocol_revenue(8) + script_len(1) + btc_script(var)
    // Old layout (v1): disc(1) + requester(32) + amount_sats(8) + actual_received(8) + service_fee(8)
    //   + request_id(8) + btc_txid(32) + script_len(1) + btc_script(var)
    if segments.len() >= 11 && segments[1].len() == 32 && segments[7].len() == 8 && segments[8].len() == 8 {
        // v2: has burn_amount + protocol_revenue
        return Some(RedemptionCompletedEvent {
            requester: read_bytes32(&segments[1])?,
            amount_sats: read_u64(&segments[2])?,
            actual_received: read_u64(&segments[3])?,
            service_fee: read_u64(&segments[4])?,
            request_id: read_u64(&segments[5])?,
            btc_txid: read_bytes32(&segments[6])?,
            burn_amount: read_u64(&segments[7])?,
            protocol_revenue: read_u64(&segments[8])?,
            btc_script: read_script(&segments[9], &segments[10]),
        });
    }

    // DEPRECATED(v1): old event format without burn_amount/protocol_revenue.
    // Remove once all historical events have been re-indexed with v2 contract.
    if segments.len() >= 9 && segments[1].len() == 32 && segments[7].len() == 1 {
        let amount_sats = read_u64(&segments[2])?;
        let actual_received = read_u64(&segments[3])?;
        let service_fee = read_u64(&segments[4])?;
        let expected_send = amount_sats.saturating_sub(service_fee);
        let miner_fee = expected_send.saturating_sub(actual_received);
        let protocol_revenue = service_fee.saturating_sub(miner_fee);
        let burn_amount = amount_sats.saturating_sub(protocol_revenue);
        return Some(RedemptionCompletedEvent {
            requester: read_bytes32(&segments[1])?,
            amount_sats,
            actual_received,
            service_fee,
            request_id: read_u64(&segments[5])?,
            btc_txid: read_bytes32(&segments[6])?,
            burn_amount,
            protocol_revenue,
            btc_script: read_script(&segments[7], &segments[8]),
        });
    }

    None
}

fn parse_redemption_requested(segments: &[Vec<u8>]) -> Option<RedemptionRequestedEvent> {
    // New layout: disc(1) + requester(32) + amount_sats(8) + request_id(8)
    //             + service_fee_base(8) + service_fee_bps(2) + script_len(1) + btc_script(var)
    // Old layout: disc(1) + requester(32) + amount_sats(8) + request_id(8) + script_len(1) + btc_script(var)
    if segments.len() < 6 {
        return None;
    }
    if segments[1].len() != 32 || segments[2].len() != 8 || segments[3].len() != 8 {
        return None;
    }

    let mut requester = [0u8; 32];
    requester.copy_from_slice(&segments[1]);

    let amount_sats = u64::from_le_bytes(segments[2][..8].try_into().ok()?);
    let request_id = u64::from_le_bytes(segments[3][..8].try_into().ok()?);

    // Detect new vs old format: new has 8 segments (added fee_base + fee_bps), old has 6
    let (service_fee_base, service_fee_bps, script_len_idx, script_data_idx) = if segments.len() >= 8
        && segments[4].len() == 8
        && segments[5].len() == 2
    {
        // New format with fee fields
        let fee_base = u64::from_le_bytes(segments[4][..8].try_into().ok()?);
        let fee_bps = u16::from_le_bytes(segments[5][..2].try_into().ok()?);
        (fee_base, fee_bps, 6, 7)
    } else {
        // Old format without fee fields
        (0u64, 0u16, 4, 5)
    };

    if segments[script_len_idx].len() != 1 {
        return None;
    }
    let script_len = segments[script_len_idx][0] as usize;
    let btc_script = if script_len > 0 && segments[script_data_idx].len() >= script_len {
        segments[script_data_idx][..script_len].to_vec()
    } else {
        segments[script_data_idx].clone()
    };

    Some(RedemptionRequestedEvent {
        requester,
        amount_sats,
        request_id,
        service_fee_base,
        service_fee_bps,
        btc_script,
    })
}

fn parse_redemption_processing(segments: &[Vec<u8>]) -> Option<RedemptionProcessingEvent> {
    // disc(1) + requester(32) + amount_sats(8) + request_id(8) + processing_slot(4)
    if segments.len() < 5 {
        return None;
    }
    if segments[1].len() != 32 || segments[2].len() != 8 || segments[3].len() != 8 || segments[4].len() != 4 {
        return None;
    }

    let mut requester = [0u8; 32];
    requester.copy_from_slice(&segments[1]);

    Some(RedemptionProcessingEvent {
        requester,
        amount_sats: u64::from_le_bytes(segments[2][..8].try_into().ok()?),
        request_id: u64::from_le_bytes(segments[3][..8].try_into().ok()?),
        processing_slot: u32::from_le_bytes(segments[4][..4].try_into().ok()?),
    })
}

/// Parse deposit verified (multi-segment): v2 has 6 segments (+ original_amount), v1 has 5
fn parse_deposit_verified(segments: &[Vec<u8>]) -> Option<DepositVerifiedEvent> {
    if segments.len() < 5 {
        return None;
    }
    if segments[1].len() != 32 || segments[2].len() != 32 || segments[3].len() != 8 || segments[4].len() != 4 {
        return None;
    }

    let original_amount = if segments.len() >= 6 && segments[5].len() == 8 {
        read_u64(&segments[5]).unwrap_or(0)
    } else {
        0
    };

    Some(DepositVerifiedEvent {
        sweep_txid: read_bytes32(&segments[1])?,
        deposit_txid: read_bytes32(&segments[2])?,
        amount_sats: read_u64(&segments[3])?,
        leaf_index: u32::from_le_bytes(segments[4][..4].try_into().ok()?),
        original_amount,
    })
}

/// Parse deposit verified (flat): v2 = 85 bytes (+ original_amount), v1 = 77 bytes
fn parse_deposit_verified_flat(data: &[u8]) -> Option<DepositVerifiedEvent> {
    if data.len() < 77 {
        return None;
    }

    let original_amount = if data.len() >= 85 {
        u64::from_le_bytes(data[77..85].try_into().ok()?)
    } else {
        0
    };

    Some(DepositVerifiedEvent {
        sweep_txid: data[1..33].try_into().ok()?,
        deposit_txid: data[33..65].try_into().ok()?,
        amount_sats: u64::from_le_bytes(data[65..73].try_into().ok()?),
        leaf_index: u32::from_le_bytes(data[73..77].try_into().ok()?),
        original_amount,
    })
}

/// Parse unshield meta (multi-segment): disc(1) + amount(8) + recipient(32) + token_id(32)
fn parse_unshield_meta(segments: &[Vec<u8>]) -> Option<UnshieldMetaEvent> {
    // v2: disc(1) + gross_amount(8) + fee(8) + payout(8) + recipient(32) + token_id(32) = 6 segments
    if segments.len() >= 6
        && segments[1].len() == 8
        && segments[2].len() == 8
        && segments[3].len() == 8
        && segments[4].len() == 32
        && segments[5].len() == 32
    {
        return Some(UnshieldMetaEvent {
            amount: read_u64(&segments[1])?,
            fee: read_u64(&segments[2])?,
            payout: read_u64(&segments[3])?,
            recipient: read_bytes32(&segments[4])?,
            token_id: read_bytes32(&segments[5])?,
        });
    }
    // v1 fallback: disc(1) + amount(8) + recipient(32) + token_id(32) = 4 segments
    if segments.len() >= 4
        && segments[1].len() == 8
        && segments[2].len() == 32
        && segments[3].len() == 32
    {
        let amount = read_u64(&segments[1])?;
        return Some(UnshieldMetaEvent {
            amount,
            fee: 0,
            payout: amount,
            recipient: read_bytes32(&segments[2])?,
            token_id: read_bytes32(&segments[3])?,
        });
    }
    None
}

/// Parse unshield meta (flat): disc(1) + amount(8) + recipient(32) + token_id(32) = 73 bytes
fn parse_unshield_meta_flat(data: &[u8]) -> Option<UnshieldMetaEvent> {
    // v2: disc(1) + gross_amount(8) + fee(8) + payout(8) + recipient(32) + token_id(32) = 89 bytes
    if data.len() >= 89 {
        return Some(UnshieldMetaEvent {
            amount: u64::from_le_bytes(data[1..9].try_into().ok()?),
            fee: u64::from_le_bytes(data[9..17].try_into().ok()?),
            payout: u64::from_le_bytes(data[17..25].try_into().ok()?),
            recipient: data[25..57].try_into().ok()?,
            token_id: data[57..89].try_into().ok()?,
        });
    }
    // v1 fallback: disc(1) + amount(8) + recipient(32) + token_id(32) = 73 bytes
    if data.len() >= 73 {
        let amount = u64::from_le_bytes(data[1..9].try_into().ok()?);
        return Some(UnshieldMetaEvent {
            amount,
            fee: 0,
            payout: amount,
            recipient: data[9..41].try_into().ok()?,
            token_id: data[41..73].try_into().ok()?,
        });
    }
    None
}

/// Parse UtxoCreated/UtxoConsumed from multi-segment: disc(1) + txid(32) + vout(4) + amount_sats(8)
fn parse_utxo_event(segments: &[Vec<u8>]) -> Option<UtxoEvent> {
    // Multi-segment: [disc(1)], [txid(32)], [vout(4)], [amount(8)]
    if segments.len() < 4 { return None; }
    if segments[1].len() != 32 || segments[2].len() != 4 || segments[3].len() != 8 {
        return None;
    }
    Some(UtxoEvent {
        txid: segments[1].as_slice().try_into().ok()?,
        vout: u32::from_le_bytes(segments[2].as_slice().try_into().ok()?),
        amount_sats: u64::from_le_bytes(segments[3].as_slice().try_into().ok()?),
    })
}

/// Parse UtxoCreated/UtxoConsumed from flat single-segment (45 bytes)
fn parse_utxo_event_flat(data: &[u8]) -> Option<UtxoEvent> {
    // disc(1) + txid(32) + vout(4) + amount_sats(8) = 45
    if data.len() < 45 { return None; }
    Some(UtxoEvent {
        txid: data[1..33].try_into().ok()?,
        vout: u32::from_le_bytes(data[33..37].try_into().ok()?),
        amount_sats: u64::from_le_bytes(data[37..45].try_into().ok()?),
    })
}

/// Parse shield metadata: disc(1) + gross_amount(8) + fee(8) + token_id(32) = 4 segments
fn parse_shield_meta(segments: &[Vec<u8>]) -> Option<ShieldMetaEvent> {
    if segments.len() < 4 { return None; }
    Some(ShieldMetaEvent {
        gross_amount: read_u64(&segments[1])?,
        fee: read_u64(&segments[2])?,
        token_id: read_bytes32(&segments[3])?,
    })
}

/// Parse shield metadata from flat buffer: disc(1) + gross_amount(8) + fee(8) + token_id(32) = 49
fn parse_shield_meta_flat(data: &[u8]) -> Option<ShieldMetaEvent> {
    if data.len() < 49 { return None; }
    Some(ShieldMetaEvent {
        gross_amount: u64::from_le_bytes(data[1..9].try_into().ok()?),
        fee: u64::from_le_bytes(data[9..17].try_into().ok()?),
        token_id: data[17..49].try_into().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn encode_segments(segments: &[&[u8]]) -> String {
        let b64_parts: Vec<String> = segments
            .iter()
            .map(|s| base64::engine::general_purpose::STANDARD.encode(s))
            .collect();
        format!("Program data: {}", b64_parts.join(" "))
    }

    #[test]
    fn test_parse_nullifier_spent() {
        let hash = [0xCDu8; 32];
        let op_type = 1u8;
        let ix_disc = 5u8;

        let log = encode_segments(&[
            &[EVENT_NULLIFIER_SPENT],
            &hash,
            &[op_type],
            &[ix_disc],
        ]);
        let events = parse_program_events(&[log]);

        assert_eq!(events.len(), 1);
        match &events[0] {
            ProgramEvent::NullifierSpent(e) => {
                assert_eq!(e.nullifier_hash, hash);
                assert_eq!(e.operation_type, 1);
                assert_eq!(e.instruction_disc, 5);
            }
            _ => panic!("wrong event type"),
        }
    }

    #[test]
    fn test_parse_nullifiers_batch() {
        let hash1 = [0xAAu8; 32];
        let hash2 = [0xBBu8; 32];
        let op_type = 3u8;
        let ix_disc = 14u8;

        let mut payload = vec![EVENT_NULLIFIERS_BATCH, 2, op_type, ix_disc];
        payload.extend_from_slice(&hash1);
        payload.extend_from_slice(&hash2);

        let b64 = base64::engine::general_purpose::STANDARD.encode(&payload);
        let log = format!("Program data: {}", b64);
        let events = parse_program_events(&[log]);

        assert_eq!(events.len(), 2);
        match &events[0] {
            ProgramEvent::NullifierSpent(e) => {
                assert_eq!(e.nullifier_hash, hash1);
                assert_eq!(e.operation_type, op_type);
                assert_eq!(e.instruction_disc, ix_disc);
            }
            _ => panic!("wrong event type"),
        }
        match &events[1] {
            ProgramEvent::NullifierSpent(e) => {
                assert_eq!(e.nullifier_hash, hash2);
                assert_eq!(e.operation_type, op_type);
                assert_eq!(e.instruction_disc, ix_disc);
            }
            _ => panic!("wrong event type"),
        }
    }

    #[test]
    fn test_parse_announcements_batch() {
        let ephemeral = [0xAAu8; 32];
        let amount = 5000u64.to_le_bytes();
        let commitment = [0xBBu8; 32];
        let leaf_index = 42u32.to_le_bytes();
        let token_id = [0xDDu8; 32];

        // v2 batch with token_id (109 bytes per item)
        let mut payload = vec![EVENT_ANNOUNCEMENTS_BATCH, 1];
        payload.push(1u8);
        payload.extend_from_slice(&ephemeral);
        payload.extend_from_slice(&amount);
        payload.extend_from_slice(&commitment);
        payload.extend_from_slice(&leaf_index);
        payload.extend_from_slice(&token_id);

        let b64 = base64::engine::general_purpose::STANDARD.encode(&payload);
        let log = format!("Program data: {}", b64);
        let events = parse_program_events(&[log]);

        assert_eq!(events.len(), 1);
        match &events[0] {
            ProgramEvent::StealthAnnouncement(e) => {
                assert_eq!(e.announcement_type, 1);
                assert_eq!(e.ephemeral_pub, ephemeral);
                assert_eq!(e.leaf_index, 42);
                assert_eq!(e.token_id, token_id);
            }
            _ => panic!("wrong event type"),
        }
    }

    #[test]
    fn test_parse_stealth_announcement() {
        let ephemeral = [0xAAu8; 32];
        let amount = 5000u64.to_le_bytes();
        let commitment = [0xBBu8; 32];
        let leaf_index = 42u32.to_le_bytes();
        let token_id = [0xDDu8; 32];

        let log = encode_segments(&[
            &[EVENT_STEALTH_ANNOUNCEMENT],
            &[1u8],
            &ephemeral,
            &amount,
            &commitment,
            &leaf_index,
            &token_id,
        ]);
        let events = parse_program_events(&[log]);
        assert_eq!(events.len(), 1);
        match &events[0] {
            ProgramEvent::StealthAnnouncement(e) => {
                assert_eq!(e.announcement_type, 1);
                assert_eq!(e.ephemeral_pub, ephemeral);
                assert_eq!(e.leaf_index, 42);
                assert_eq!(e.token_id, token_id);
            }
            _ => panic!("wrong event type"),
        }
    }

    #[test]
    fn test_parse_nullifiers_batch_multi_segment() {
        // On-chain emits NullifiersBatch as separate segments via sol_log_data
        let hash1 = [0xAAu8; 32];
        let hash2 = [0xBBu8; 32];
        let op_type = 2u8;
        let ix_disc = 14u8;

        let log = encode_segments(&[
            &[EVENT_NULLIFIERS_BATCH],
            &[2u8],       // count
            &[op_type],   // op_type
            &[ix_disc],   // ix_disc
            &hash1,
            &hash2,
        ]);
        let events = parse_program_events(&[log]);

        assert_eq!(events.len(), 2);
        match &events[0] {
            ProgramEvent::NullifierSpent(e) => {
                assert_eq!(e.nullifier_hash, hash1);
                assert_eq!(e.operation_type, op_type);
                assert_eq!(e.instruction_disc, ix_disc);
            }
            _ => panic!("wrong event type"),
        }
        match &events[1] {
            ProgramEvent::NullifierSpent(e) => {
                assert_eq!(e.nullifier_hash, hash2);
                assert_eq!(e.operation_type, op_type);
                assert_eq!(e.instruction_disc, ix_disc);
            }
            _ => panic!("wrong event type"),
        }
    }

    #[test]
    fn test_parse_deposit_verified_v2() {
        let sweep_txid = [0xAAu8; 32];
        let deposit_txid = [0xBBu8; 32];
        let amount: u64 = 24_000;
        let leaf_index: u32 = 7;
        let original: u64 = 25_000;

        let log = encode_segments(&[
            &[EVENT_DEPOSIT_VERIFIED],
            &sweep_txid,
            &deposit_txid,
            &amount.to_le_bytes(),
            &leaf_index.to_le_bytes(),
            &original.to_le_bytes(),
        ]);
        let events = parse_program_events(&[log]);

        assert_eq!(events.len(), 1);
        match &events[0] {
            ProgramEvent::DepositVerified(e) => {
                assert_eq!(e.sweep_txid, sweep_txid);
                assert_eq!(e.deposit_txid, deposit_txid);
                assert_eq!(e.amount_sats, 24_000);
                assert_eq!(e.leaf_index, 7);
                assert_eq!(e.original_amount, 25_000);
            }
            _ => panic!("wrong event type"),
        }
    }

    #[test]
    fn test_parse_deposit_verified_v1_fallback() {
        let sweep_txid = [0xAAu8; 32];
        let deposit_txid = [0xBBu8; 32];
        let amount: u64 = 100_000;
        let leaf_index: u32 = 7;

        let log = encode_segments(&[
            &[EVENT_DEPOSIT_VERIFIED],
            &sweep_txid,
            &deposit_txid,
            &amount.to_le_bytes(),
            &leaf_index.to_le_bytes(),
        ]);
        let events = parse_program_events(&[log]);

        assert_eq!(events.len(), 1);
        match &events[0] {
            ProgramEvent::DepositVerified(e) => {
                assert_eq!(e.amount_sats, 100_000);
                assert_eq!(e.original_amount, 0); // v1 has no original_amount
            }
            _ => panic!("wrong event type"),
        }
    }

    #[test]
    fn test_parse_unshield_meta_v2() {
        let gross: u64 = 50_000;
        let fee: u64 = 100;
        let payout: u64 = 49_900;
        let recipient = [0xCCu8; 32];
        let token_id = [0xAAu8; 32];

        let log = encode_segments(&[
            &[EVENT_UNSHIELD_META],
            &gross.to_le_bytes(),
            &fee.to_le_bytes(),
            &payout.to_le_bytes(),
            &recipient,
            &token_id,
        ]);
        let events = parse_program_events(&[log]);

        assert_eq!(events.len(), 1);
        match &events[0] {
            ProgramEvent::UnshieldMeta(e) => {
                assert_eq!(e.amount, 50_000);
                assert_eq!(e.fee, 100);
                assert_eq!(e.payout, 49_900);
                assert_eq!(e.recipient, recipient);
                assert_eq!(e.token_id, token_id);
            }
            _ => panic!("wrong event type"),
        }
    }

    #[test]
    fn test_parse_unshield_meta_v1_fallback() {
        let amount: u64 = 50_000;
        let recipient = [0xCCu8; 32];
        let token_id = [0xAAu8; 32];

        let log = encode_segments(&[
            &[EVENT_UNSHIELD_META],
            &amount.to_le_bytes(),
            &recipient,
            &token_id,
        ]);
        let events = parse_program_events(&[log]);

        assert_eq!(events.len(), 1);
        match &events[0] {
            ProgramEvent::UnshieldMeta(e) => {
                assert_eq!(e.amount, 50_000);
                assert_eq!(e.fee, 0);
                assert_eq!(e.payout, 50_000);
                assert_eq!(e.recipient, recipient);
                assert_eq!(e.token_id, token_id);
            }
            _ => panic!("wrong event type"),
        }
    }

    #[test]
    fn test_ignores_unrelated_logs() {
        let logs = vec![
            "Program log: some message".to_string(),
            "Program B2H3B6iDg invoke [1]".to_string(),
        ];
        let events = parse_program_events(&logs);
        assert!(events.is_empty());
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    
    #[test]
    fn test_parse_real_unshield_logs() {
        let logs = vec![
            "Program ComputeBudget111111111111111111111111111111 invoke [1]".to_string(),
            "Program ComputeBudget111111111111111111111111111111 success".to_string(),
            "Program 6cv5vLKCc19oDHMSv1eSLvkJw6Nq1QkvznXavEF6hcDT invoke [1]".to_string(),
            "Program log: UTXOpia: groth16 verifying".to_string(),
            "Program log: UTXOpia: groth16 pairing check".to_string(),
            "Program log: UTXOpia: groth16 proof verified".to_string(),
            "Program 11111111111111111111111111111111 invoke [2]".to_string(),
            "Program 11111111111111111111111111111111 success".to_string(),
            "Program data: Ag== Drf9e9z3IYQJFoHdF53QX4aedxOBneEhhRj8nykHQ2E= AA== Dg==".to_string(),
            "Program data: Dg== QLKRAwAAAAA= 0NMBAAAAAAA= cN6PAwAAAAA= KWz0BxV5FyNQycyLzzPRucF88GTc8IKN1WAlRxUvNII= Ac1BKFX9QwlNB4dvmAFYq/uioh8T/Z28qUCnogTtWno=".to_string(),
            "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]".to_string(),
            "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb success".to_string(),
            "Program data: Dg== gCFhAgAAAAA= 4DcBAAAAAAA= oOlfAgAAAAA= KWz0BxV5FyNQycyLzzPRucF88GTc8IKN1WAlRxUvNII= Ac1BKFX9QwlNB4dvmAFYq/uioh8T/Z28qUCnogTtWno=".to_string(),
            "Program 6cv5vLKCc19oDHMSv1eSLvkJw6Nq1QkvznXavEF6hcDT success".to_string(),
        ];
        
        let events = parse_program_events(&logs);
        let mut nullifiers = 0;
        let mut unshield_metas = 0;
        for e in &events {
            match e {
                ProgramEvent::NullifierSpent(_) => nullifiers += 1,
                ProgramEvent::UnshieldMeta(um) => {
                    unshield_metas += 1;
                    println!("UnshieldMeta: amount={}, fee={}, payout={}", um.amount, um.fee, um.payout);
                },
                _ => {}
            }
        }
        println!("Total events: {}, nullifiers: {}, unshield_metas: {}", events.len(), nullifiers, unshield_metas);
        assert!(unshield_metas >= 2, "Expected at least 2 UnshieldMeta events, got {}", unshield_metas);
    }
}
