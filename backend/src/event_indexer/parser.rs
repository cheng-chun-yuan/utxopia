//! Event parser for Aegis sol_log_data events
//!
//! Matches discriminators from contracts/programs/aegis/src/utils/events.rs:
//! - 0x01 = LeafInserted (commitment + created_at)
//! - 0x02 = NullifierSpent (nullifier_hash + op_type + spent_at + spent_by)

use base64::Engine;

/// Event discriminators matching on-chain events.rs
const EVENT_LEAF_INSERTED: u8 = 0x01;
const EVENT_NULLIFIER_SPENT: u8 = 0x02;
const EVENT_STEALTH_ANNOUNCEMENT: u8 = 0x03;

/// Parsed leaf inserted event
#[derive(Debug, Clone)]
pub struct LeafInsertedEvent {
    pub commitment: [u8; 32],
    pub created_at: i64,
}

/// Parsed nullifier spent event
#[derive(Debug, Clone)]
pub struct NullifierSpentEvent {
    pub nullifier_hash: [u8; 32],
    pub operation_type: u8,
    pub spent_at: i64,
    pub spent_by: [u8; 32],
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
    LeafInserted(LeafInsertedEvent),
    NullifierSpent(NullifierSpentEvent),
    StealthAnnouncement(StealthAnnouncementEvent),
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

        if segments.is_empty() || segments[0].len() != 1 {
            continue;
        }

        let disc = segments[0][0];

        match disc {
            EVENT_LEAF_INSERTED => {
                if let Some(event) = parse_leaf_inserted(&segments) {
                    events.push(ProgramEvent::LeafInserted(event));
                }
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
            _ => {}
        }
    }

    events
}

fn parse_leaf_inserted(segments: &[Vec<u8>]) -> Option<LeafInsertedEvent> {
    // disc(1) + commitment(32) + created_at(8)
    if segments.len() < 3 {
        return None;
    }
    if segments[1].len() != 32 || segments[2].len() != 8 {
        return None;
    }

    let mut commitment = [0u8; 32];
    commitment.copy_from_slice(&segments[1]);

    let created_at = i64::from_le_bytes(segments[2][..8].try_into().ok()?);

    Some(LeafInsertedEvent {
        commitment,
        created_at,
    })
}

fn parse_nullifier_spent(segments: &[Vec<u8>]) -> Option<NullifierSpentEvent> {
    // disc(1) + nullifier_hash(32) + op_type(1) + spent_at(8) + spent_by(32)
    if segments.len() < 5 {
        return None;
    }
    if segments[1].len() != 32 || segments[2].len() != 1 || segments[3].len() != 8 || segments[4].len() != 32 {
        return None;
    }

    let mut nullifier_hash = [0u8; 32];
    nullifier_hash.copy_from_slice(&segments[1]);

    let operation_type = segments[2][0];
    let spent_at = i64::from_le_bytes(segments[3][..8].try_into().ok()?);

    let mut spent_by = [0u8; 32];
    spent_by.copy_from_slice(&segments[4]);

    Some(NullifierSpentEvent {
        nullifier_hash,
        operation_type,
        spent_at,
        spent_by,
    })
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
    fn test_parse_leaf_inserted() {
        let commitment = [0xABu8; 32];
        let created_at: i64 = 1700000000;
        let ts_bytes = created_at.to_le_bytes();

        let log = encode_segments(&[&[EVENT_LEAF_INSERTED], &commitment, &ts_bytes]);
        let events = parse_program_events(&[log]);

        assert_eq!(events.len(), 1);
        match &events[0] {
            ProgramEvent::LeafInserted(e) => {
                assert_eq!(e.commitment, commitment);
                assert_eq!(e.created_at, created_at);
            }
            _ => panic!("wrong event type"),
        }
    }

    #[test]
    fn test_parse_nullifier_spent() {
        let hash = [0xCDu8; 32];
        let op_type = 2u8; // PrivateTransfer
        let spent_at: i64 = 1700000001;
        let spent_by = [0xEFu8; 32];

        let log = encode_segments(&[
            &[EVENT_NULLIFIER_SPENT],
            &hash,
            &[op_type],
            &spent_at.to_le_bytes(),
            &spent_by,
        ]);
        let events = parse_program_events(&[log]);

        assert_eq!(events.len(), 1);
        match &events[0] {
            ProgramEvent::NullifierSpent(e) => {
                assert_eq!(e.nullifier_hash, hash);
                assert_eq!(e.operation_type, 2);
                assert_eq!(e.spent_at, spent_at);
                assert_eq!(e.spent_by, spent_by);
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
    fn test_ignores_unrelated_logs() {
        let logs = vec![
            "Program log: some message".to_string(),
            "Program B2H3B6iDg invoke [1]".to_string(),
        ];
        let events = parse_program_events(&logs);
        assert!(events.is_empty());
    }
}
