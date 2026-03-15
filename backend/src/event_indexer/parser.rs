//! Event parser for Aegis sol_log_data events
//!
//! Matches discriminators from contracts/programs/aegis/src/utils/events.rs:
//! - 0x02 = NullifierSpent (nullifier_hash + op_type + ix_disc)
//! - 0x03 = StealthAnnouncement (type + ephemeral + amount + commitment + leaf_index)
//! - 0x07 = RedemptionCompleted
//! - 0x08 = RedemptionRequested
//! - 0x0A = RedemptionProcessing
//! - 0x0B = NullifiersBatch (count + op_type + ix_disc + [hash] x N)
//! - 0x0C = AnnouncementsBatch (count + [type + ephemeral + amount + commitment + leaf_index] x N)
//! - 0x0D = DepositVerified (sweep_txid + deposit_txid + amount_sats + leaf_index)
//! - 0x0E = UnshieldMeta (amount + recipient)

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
}

/// Parsed unshield/redeem metadata event
#[derive(Debug, Clone)]
pub struct UnshieldMetaEvent {
    pub amount: u64,
    pub recipient: [u8; 32],
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
            _ => {}
        }
    }

    events
}

/// Parse nullifier spent: disc(1) + hash(32) + op_type(1) + ix_disc(1)
fn parse_nullifier_spent(segments: &[Vec<u8>]) -> Option<NullifierSpentEvent> {
    if segments.len() < 3 {
        return None;
    }
    if segments[1].len() != 32 || segments[2].len() != 1 {
        return None;
    }

    let mut nullifier_hash = [0u8; 32];
    nullifier_hash.copy_from_slice(&segments[1]);

    // ix_disc is optional (backward compat with old contract)
    let instruction_disc = if segments.len() >= 4 && segments[3].len() == 1 {
        segments[3][0]
    } else {
        0
    };

    Some(NullifierSpentEvent {
        nullifier_hash,
        operation_type: segments[2][0],
        instruction_disc,
    })
}

/// Parse batched nullifiers from multi-segment sol_log_data.
///
/// On-chain emits: sol_log_data(&[disc, count, op_type, ix_disc, hash1, hash2, ...])
/// The runtime may drop the ix_disc segment, producing only:
///   [disc, count, op_type, hash1, hash2, ...]
/// We detect both formats by checking whether segment[3] is 1 byte (ix_disc) or 32 bytes (hash).
fn parse_nullifiers_batch_segments(segments: &[Vec<u8>]) -> Vec<NullifierSpentEvent> {
    // Need at least disc + count + op_type + 1 hash = 4 segments minimum
    if segments.len() < 4 {
        return Vec::new();
    }
    if segments[1].len() != 1 || segments[2].len() != 1 {
        return Vec::new();
    }

    let count = segments[1][0] as usize;
    let op_type = segments[2][0];

    // Detect format: if segment[3] is 1 byte, it's ix_disc; if 32 bytes, hashes start here
    let (ix_disc, hash_start) = if segments.len() > 3 && segments[3].len() == 1 {
        (segments[3][0], 4)
    } else {
        (0, 3) // ix_disc dropped by runtime, hashes start at segment[3]
    };

    let mut events = Vec::with_capacity(count);
    for i in 0..count {
        let idx = hash_start + i;
        if idx >= segments.len() || segments[idx].len() != 32 {
            break;
        }
        let mut nullifier_hash = [0u8; 32];
        nullifier_hash.copy_from_slice(&segments[idx]);
        events.push(NullifierSpentEvent {
            nullifier_hash,
            operation_type: op_type,
            instruction_disc: ix_disc,
        });
    }

    events
}

/// Parse batched nullifiers from single flat segment: disc(1) + count(1) + op_type(1) + ix_disc(1) + [hash(32)] x N
fn parse_nullifiers_batch(data: &[u8]) -> Vec<NullifierSpentEvent> {
    if data.len() < 4 {
        return Vec::new();
    }

    let count = data[1] as usize;
    let op_type = data[2];
    let ix_disc = data[3];
    let expected_len = 4 + count * 32;
    if data.len() < expected_len {
        return Vec::new();
    }

    let mut events = Vec::with_capacity(count);
    for i in 0..count {
        let offset = 4 + i * 32;
        let mut nullifier_hash = [0u8; 32];
        nullifier_hash.copy_from_slice(&data[offset..offset + 32]);
        events.push(NullifierSpentEvent {
            nullifier_hash,
            operation_type: op_type,
            instruction_disc: ix_disc,
        });
    }

    events
}

/// Parse batched announcements: disc(1) + count(1) + [type(1) + ephemeral(32) + amount(8) + commitment(32) + leaf_index(4)] x N
fn parse_announcements_batch(data: &[u8]) -> Vec<StealthAnnouncementEvent> {
    if data.len() < 2 {
        return Vec::new();
    }

    let count = data[1] as usize;
    let item_size = 1 + 32 + 8 + 32 + 4; // 77 bytes per item
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

        events.push(StealthAnnouncementEvent {
            announcement_type,
            ephemeral_pub,
            encrypted_amount,
            commitment,
            leaf_index,
        });
    }

    events
}

fn parse_stealth_announcement(segments: &[Vec<u8>]) -> Option<StealthAnnouncementEvent> {
    // disc(1) + type(1) + ephemeral_pub(32) + encrypted_amount(8) + commitment(32) + leaf_index(4)
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

    Some(StealthAnnouncementEvent {
        announcement_type: segments[1][0],
        ephemeral_pub,
        encrypted_amount,
        commitment,
        leaf_index,
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

    // TODO(backward-compat): v1 fallback — derive burn/revenue from other fields
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

/// Parse deposit verified (multi-segment): disc(1) + sweep_txid(32) + deposit_txid(32) + amount_sats(8) + leaf_index(4)
fn parse_deposit_verified(segments: &[Vec<u8>]) -> Option<DepositVerifiedEvent> {
    if segments.len() < 5 {
        return None;
    }
    if segments[1].len() != 32 || segments[2].len() != 32 || segments[3].len() != 8 || segments[4].len() != 4 {
        return None;
    }

    Some(DepositVerifiedEvent {
        sweep_txid: read_bytes32(&segments[1])?,
        deposit_txid: read_bytes32(&segments[2])?,
        amount_sats: read_u64(&segments[3])?,
        leaf_index: u32::from_le_bytes(segments[4][..4].try_into().ok()?),
    })
}

/// Parse deposit verified (flat): disc(1) + sweep_txid(32) + deposit_txid(32) + amount_sats(8) + leaf_index(4) = 77 bytes
fn parse_deposit_verified_flat(data: &[u8]) -> Option<DepositVerifiedEvent> {
    if data.len() < 77 {
        return None;
    }

    Some(DepositVerifiedEvent {
        sweep_txid: data[1..33].try_into().ok()?,
        deposit_txid: data[33..65].try_into().ok()?,
        amount_sats: u64::from_le_bytes(data[65..73].try_into().ok()?),
        leaf_index: u32::from_le_bytes(data[73..77].try_into().ok()?),
    })
}

/// Parse unshield meta (multi-segment): disc(1) + amount(8) + recipient(32)
fn parse_unshield_meta(segments: &[Vec<u8>]) -> Option<UnshieldMetaEvent> {
    if segments.len() < 3 {
        return None;
    }
    if segments[1].len() != 8 || segments[2].len() != 32 {
        return None;
    }

    Some(UnshieldMetaEvent {
        amount: read_u64(&segments[1])?,
        recipient: read_bytes32(&segments[2])?,
    })
}

/// Parse unshield meta (flat): disc(1) + amount(8) + recipient(32) = 41 bytes
fn parse_unshield_meta_flat(data: &[u8]) -> Option<UnshieldMetaEvent> {
    if data.len() < 41 {
        return None;
    }

    Some(UnshieldMetaEvent {
        amount: u64::from_le_bytes(data[1..9].try_into().ok()?),
        recipient: data[9..41].try_into().ok()?,
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

        let mut payload = vec![EVENT_ANNOUNCEMENTS_BATCH, 1];
        payload.push(1u8);
        payload.extend_from_slice(&ephemeral);
        payload.extend_from_slice(&amount);
        payload.extend_from_slice(&commitment);
        payload.extend_from_slice(&leaf_index);

        let b64 = base64::engine::general_purpose::STANDARD.encode(&payload);
        let log = format!("Program data: {}", b64);
        let events = parse_program_events(&[log]);

        assert_eq!(events.len(), 1);
        match &events[0] {
            ProgramEvent::StealthAnnouncement(e) => {
                assert_eq!(e.announcement_type, 1);
                assert_eq!(e.ephemeral_pub, ephemeral);
                assert_eq!(e.leaf_index, 42);
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

        let log = encode_segments(&[
            &[EVENT_STEALTH_ANNOUNCEMENT],
            &[1u8],
            &ephemeral,
            &amount,
            &commitment,
            &leaf_index,
        ]);
        let events = parse_program_events(&[log]);
        assert_eq!(events.len(), 1);
        match &events[0] {
            ProgramEvent::StealthAnnouncement(e) => {
                assert_eq!(e.announcement_type, 1);
                assert_eq!(e.ephemeral_pub, ephemeral);
                assert_eq!(e.leaf_index, 42);
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
    fn test_parse_deposit_verified() {
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
                assert_eq!(e.sweep_txid, sweep_txid);
                assert_eq!(e.deposit_txid, deposit_txid);
                assert_eq!(e.amount_sats, 100_000);
                assert_eq!(e.leaf_index, 7);
            }
            _ => panic!("wrong event type"),
        }
    }

    #[test]
    fn test_parse_unshield_meta() {
        let amount: u64 = 50_000;
        let recipient = [0xCCu8; 32];

        let log = encode_segments(&[
            &[EVENT_UNSHIELD_META],
            &amount.to_le_bytes(),
            &recipient,
        ]);
        let events = parse_program_events(&[log]);

        assert_eq!(events.len(), 1);
        match &events[0] {
            ProgramEvent::UnshieldMeta(e) => {
                assert_eq!(e.amount, 50_000);
                assert_eq!(e.recipient, recipient);
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
