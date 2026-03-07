//! Relayer Fee Note Scanner
//!
//! The relayer submits Solana transactions on behalf of users during private
//! JoinSplit transfers. To compensate, users include an extra output note
//! addressed to the relayer's stealth address. This is the **relayer fee**.
//!
//! Separate from the **service fee** (withdrawal fee that goes to the pool).
//!
//! Fee model:
//! - Relayer fee: shielded note → relayer (for private sends)
//! - Service fee: deducted from BTC amount → pool (for withdrawals)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Relayer configuration for private send fee collection
#[derive(Debug, Clone)]
pub struct RelayerConfig {
    /// Flat relayer fee in sats — user adds this as an extra output note to relayer
    pub relayer_fee_sats: u64,
    /// Hex-encoded relayer stealth meta-address (users derive one-time address from this)
    pub stealth_meta: Option<String>,
    /// Scan interval in seconds
    pub scan_interval_secs: u64,
}

impl Default for RelayerConfig {
    fn default() -> Self {
        Self {
            relayer_fee_sats: std::env::var("RELAYER_FEE_SATS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(2_000),
            stealth_meta: std::env::var("RELAYER_STEALTH_META").ok(),
            scan_interval_secs: 60,
        }
    }
}

/// A detected fee note addressed to the relayer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayerFeeNote {
    /// StealthAnnouncement PDA address
    pub pda_address: String,
    /// Amount in sats
    pub amount_sats: u64,
    /// Leaf index in Merkle tree
    pub leaf_index: u64,
    /// Whether this note has been claimed (spent via JoinSplit)
    pub claimed: bool,
    /// Unix timestamp when detected
    pub detected_at: u64,
}

/// In-memory tracker for relayer fee notes (shielded notes paid to relayer)
#[derive(Debug, Default)]
pub struct RelayerFeeTracker {
    /// Known fee notes keyed by PDA address
    notes: HashMap<String, RelayerFeeNote>,
}

impl RelayerFeeTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a newly detected fee note
    pub fn add_note(&mut self, note: RelayerFeeNote) {
        self.notes.insert(note.pda_address.clone(), note);
    }

    /// Get all unclaimed notes
    pub fn unclaimed_notes(&self) -> Vec<&RelayerFeeNote> {
        self.notes.values().filter(|n| !n.claimed).collect()
    }

    /// Total unclaimed sats
    pub fn total_unclaimed_sats(&self) -> u64 {
        self.notes.values().filter(|n| !n.claimed).map(|n| n.amount_sats).sum()
    }

    /// Mark a note as claimed
    pub fn mark_claimed(&mut self, pda_address: &str) {
        if let Some(note) = self.notes.get_mut(pda_address) {
            note.claimed = true;
        }
    }
}
