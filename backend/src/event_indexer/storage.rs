//! SQLite storage for indexed events
//!
//! Tables: leaves, nullifiers, transfers, announcements, redemptions, indexer_state.
//! Uses r2d2 connection pooling for concurrent read/write access.
//! Provides typed query methods for each event type with efficient lookups by
//! commitment, nullifier hash, leaf index, and transaction signature.

use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;
use std::path::Path;

use super::parser::{NullifierSpentEvent, RedemptionCompletedEvent, RedemptionProcessingEvent, RedemptionRequestedEvent, StealthAnnouncementEvent};

/// SQLite-backed event store
pub struct EventStore {
    pool: Pool<SqliteConnectionManager>,
}

/// A leaf event row returned by queries (enriched with announcement data)
#[derive(Debug, Clone, serde::Serialize)]
pub struct LeafRow {
    pub leaf_index: i64,
    pub commitment: String, // hex
    pub created_at: i64,
    pub tx_signature: String,
    pub slot: i64,
    /// 0=deposit, 1=transfer (from stealth_announcements table)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub announcement_type: Option<i64>,
    /// Plaintext amount in sats (only for deposits, decoded from encrypted_amount)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_sats: Option<i64>,
    /// Ephemeral public key hex (from stealth_announcements)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ephemeral_pub: Option<String>,
}

/// A nullifier event row returned by queries
#[derive(Debug, Clone, serde::Serialize)]
pub struct NullifierRow {
    pub nullifier_hash: String, // hex
    pub operation_type: i64,
    pub spent_at: i64,
    pub spent_by: String, // base58
    pub tx_signature: String,
    pub slot: i64,
}

/// A transfer grouped by tx_signature, with inputs (nullifiers) and outputs (commitments)
#[derive(Debug, Clone, serde::Serialize)]
pub struct TransferRow {
    pub tx_signature: String,
    pub commitments: Vec<String>,
    pub leaf_indices: Vec<i64>,
    pub nullifier_hashes: Vec<String>,
    pub output_count: i64,
    pub input_count: i64,
    pub timestamp: i64, // spent_at from nullifier_events
    /// "confirmed" when timestamp > 0, "processing" when timestamp is 0 (not yet confirmed)
    pub status: String,
    /// NullifierOperationType: 0=FullWithdrawal (unshield/redeem), 1=PartialWithdrawal, 2=PrivateTransfer
    pub operation_type: i64,
    /// Aegis instruction discriminator: 14=transact, 15=unshield, 5=request_redemption, 16=redeem
    pub instruction_disc: Option<i64>,
    /// Token transfer amount in sats (unshield txs only) — gross amount before fee
    pub unshield_amount: Option<i64>,
    /// Token transfer recipient wallet (unshield txs only)
    pub unshield_recipient: Option<String>,
    /// Token ID hex (from announcement event)
    pub token_id: Option<String>,
    /// Event-derived transfer type: "private_transfer", "unshield", "redeem", "deposit"
    pub transfer_type: String,
    /// Protocol fee deducted from unshield (from UnshieldMeta v2 event)
    pub unshield_fee: Option<i64>,
    /// Net payout after fee (from UnshieldMeta v2 event)
    pub unshield_payout: Option<i64>,
    /// Per-output detail JSON array for multi-output unshield/withdraw
    pub unshield_outputs: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AnnouncementRow {
    pub leaf_index: i64,
    pub announcement_type: i64,
    pub ephemeral_pub: String,   // hex
    pub encrypted_amount: String, // hex
    pub commitment: String,       // hex
    pub tx_signature: String,
    #[serde(skip_serializing)]
    pub slot: i64,
    /// Block time from getTransaction RPC (Unix timestamp)
    #[serde(skip_serializing)]
    pub block_time: i64,
    /// Whether this deposit was SPV-verified (real BTC deposit vs demo)
    #[serde(skip_serializing)]
    pub is_verified: bool,
    /// BTC deposit txid (display hex, only for verified deposits)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub btc_deposit_txid: Option<String>,
    /// BTC sweep txid (display hex, only for verified deposits)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub btc_sweep_txid: Option<String>,
    /// Original BTC deposit amount in sats (from mempool, before sweep fee)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub btc_deposit_amount_sats: Option<i64>,
    /// Token ID hex (32 bytes, from on-chain event)
    pub token_id: String,
    /// Gross deposit amount (before fee deduction, from ShieldMeta event)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deposit_gross_amount: Option<i64>,
    /// Deposit fee deducted (from ShieldMeta event)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deposit_fee: Option<i64>,
}

/// Intermediate struct for Step 1 of get_transfers(): grouped announcement outputs
struct PartialTransfer {
    tx_signature: String,
    commitments: Vec<String>,
    leaf_indices: Vec<i64>,
    output_count: i64,
    token_id: Option<String>,
}

/// Intermediate struct for nullifier row data used in get_transfers()
struct NullRow {
    hash: String,
    spent_at: i64,
    block_time: i64,
    op_type: i64,
    disc: Option<i64>,
    ua: Option<i64>,
    ur: Option<String>,
    tt: Option<String>,
    tid: Option<String>,
    uf: Option<i64>,
    up: Option<i64>,
    uoutputs: Option<String>,
}

/// A completed redemption row (from on-chain event 0x07)
#[derive(Debug, Clone, serde::Serialize)]
pub struct RedemptionCompletedRow {
    pub requester: String,     // base58
    pub amount_sats: i64,
    pub actual_received: i64,  // net BTC sent to user
    pub service_fee: i64,      // service fee locked at request time
    pub request_id: i64,
    pub btc_txid: String,      // display hex (reversed)
    pub btc_script: String,    // hex
    pub tx_signature: String,  // Solana tx sig
    pub slot: i64,
    pub block_time: i64,
    pub burn_amount: i64,      // zkBTC burned from vault (received + miner_fee)
    pub protocol_revenue: i64, // fee retained in vault (service_fee - miner_fee)
}

/// A requested redemption row (from on-chain event 0x08)
#[derive(Debug, Clone, serde::Serialize)]
pub struct RedemptionRequestedRow {
    pub requester: String,     // base58
    pub amount_sats: i64,
    pub request_id: i64,
    pub service_fee_base: i64, // fee config at request time
    pub service_fee_bps: i64,  // fee config at request time
    pub btc_script: String,    // hex
    pub tx_signature: String,  // Solana tx sig
    pub slot: i64,
    pub block_time: i64,
}

/// A redemption processing row (from on-chain event 0x0A)
#[derive(Debug, Clone, serde::Serialize)]
pub struct RedemptionProcessingRow {
    pub requester: String,     // base58
    pub amount_sats: i64,
    pub request_id: i64,
    pub processing_slot: i64,
    pub tx_signature: String,  // Solana tx sig
    pub slot: i64,
    pub block_time: i64,
}

impl EventStore {
    /// Create a new event store with the given database path
    pub fn new<P: AsRef<Path>>(db_path: P) -> Result<Self, String> {
        if let Some(parent) = db_path.as_ref().parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let manager = SqliteConnectionManager::file(db_path);
        let pool = Pool::builder()
            .max_size(5)
            .build(manager)
            .map_err(|e| format!("pool error: {}", e))?;

        let store = Self { pool };
        store.run_migrations()?;
        Ok(store)
    }

    /// Create an in-memory store (for testing)
    pub fn in_memory() -> Result<Self, String> {
        let manager = SqliteConnectionManager::memory();
        let pool = Pool::builder()
            .max_size(1)
            .build(manager)
            .map_err(|e| format!("pool error: {}", e))?;

        let store = Self { pool };
        store.run_migrations()?;
        Ok(store)
    }

    fn conn(&self) -> Result<PooledConnection<SqliteConnectionManager>, String> {
        self.pool.get().map_err(|e| format!("conn error: {}", e))
    }

    fn run_migrations(&self) -> Result<(), String> {
        let conn = self.conn()?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS leaf_events (
                leaf_index INTEGER PRIMARY KEY,
                commitment BLOB NOT NULL,
                created_at INTEGER NOT NULL,
                tx_signature TEXT NOT NULL,
                slot INTEGER NOT NULL,
                block_time INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS nullifier_events (
                nullifier_hash BLOB PRIMARY KEY,
                operation_type INTEGER NOT NULL,
                spent_at INTEGER NOT NULL,
                spent_by TEXT NOT NULL,
                tx_signature TEXT NOT NULL,
                slot INTEGER NOT NULL,
                block_time INTEGER NOT NULL DEFAULT 0,
                instruction_disc INTEGER,
                unshield_amount INTEGER,
                unshield_recipient TEXT,
                transfer_type TEXT,
                token_id TEXT
            );

            CREATE TABLE IF NOT EXISTS stealth_announcements (
                leaf_index INTEGER PRIMARY KEY,
                announcement_type INTEGER NOT NULL,
                ephemeral_pub BLOB NOT NULL,
                encrypted_amount BLOB NOT NULL,
                commitment BLOB NOT NULL,
                tx_signature TEXT NOT NULL,
                slot INTEGER NOT NULL,
                block_time INTEGER NOT NULL DEFAULT 0,
                token_id BLOB NOT NULL
            );

            CREATE TABLE IF NOT EXISTS indexer_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Performance indexes for common query patterns
            CREATE INDEX IF NOT EXISTS idx_leaf_slot ON leaf_events(slot);
            CREATE INDEX IF NOT EXISTS idx_leaf_commitment ON leaf_events(commitment);
            CREATE INDEX IF NOT EXISTS idx_nullifier_slot ON nullifier_events(slot);
            CREATE INDEX IF NOT EXISTS idx_nullifier_tx ON nullifier_events(tx_signature);
            CREATE INDEX IF NOT EXISTS idx_announcement_slot ON stealth_announcements(slot);
            CREATE INDEX IF NOT EXISTS idx_announcement_commitment ON stealth_announcements(commitment);
            CREATE INDEX IF NOT EXISTS idx_announcement_tx ON stealth_announcements(tx_signature);
            ",
        )
        .map_err(|e| format!("migration error: {}", e))?;

        // Add block_time column to existing tables (idempotent migration)
        for table in &["leaf_events", "nullifier_events", "stealth_announcements"] {
            let _ = conn.execute_batch(
                &format!("ALTER TABLE {} ADD COLUMN block_time INTEGER NOT NULL DEFAULT 0", table),
            ); // Ignore error if column already exists
        }

        // Add is_verified column to stealth_announcements (real BTC deposit vs demo)
        let _ = conn.execute_batch(
            "ALTER TABLE stealth_announcements ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 0",
        );

        // Add BTC txid columns to stealth_announcements (for verified deposits)
        let _ = conn.execute_batch(
            "ALTER TABLE stealth_announcements ADD COLUMN btc_deposit_txid TEXT",
        );
        let _ = conn.execute_batch(
            "ALTER TABLE stealth_announcements ADD COLUMN btc_sweep_txid TEXT",
        );

        // Add BTC deposit amount column (original amount before sweep fee)
        let _ = conn.execute_batch(
            "ALTER TABLE stealth_announcements ADD COLUMN btc_deposit_amount_sats INTEGER",
        );

        // Add deposit fee columns (gross amount + fee from ShieldMeta event)
        let _ = conn.execute_batch(
            "ALTER TABLE stealth_announcements ADD COLUMN deposit_gross_amount INTEGER",
        );
        let _ = conn.execute_batch(
            "ALTER TABLE stealth_announcements ADD COLUMN deposit_fee INTEGER",
        );

        // Redemption completed events table
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS redemption_completed_events (
                request_id INTEGER PRIMARY KEY,
                requester TEXT NOT NULL,
                amount_sats INTEGER NOT NULL,
                actual_received INTEGER NOT NULL DEFAULT 0,
                btc_txid TEXT NOT NULL,
                btc_script BLOB NOT NULL,
                tx_signature TEXT NOT NULL,
                slot INTEGER NOT NULL,
                block_time INTEGER NOT NULL DEFAULT 0
            )",
        );

        // Migration: add actual_received column if missing (for existing DBs)
        let _ = conn.execute_batch(
            "ALTER TABLE redemption_completed_events ADD COLUMN actual_received INTEGER NOT NULL DEFAULT 0",
        );

        // Migration: add service_fee column if missing
        let _ = conn.execute_batch(
            "ALTER TABLE redemption_completed_events ADD COLUMN service_fee INTEGER NOT NULL DEFAULT 0",
        );

        // Migration: add burn_amount + protocol_revenue columns
        let _ = conn.execute_batch(
            "ALTER TABLE redemption_completed_events ADD COLUMN burn_amount INTEGER NOT NULL DEFAULT 0",
        );
        let _ = conn.execute_batch(
            "ALTER TABLE redemption_completed_events ADD COLUMN protocol_revenue INTEGER NOT NULL DEFAULT 0",
        );

        // Redemption requested events table
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS redemption_requested_events (
                request_id INTEGER NOT NULL,
                requester TEXT NOT NULL,
                amount_sats INTEGER NOT NULL,
                btc_script BLOB NOT NULL,
                tx_signature TEXT NOT NULL,
                slot INTEGER NOT NULL,
                block_time INTEGER NOT NULL DEFAULT 0,
                service_fee_base INTEGER NOT NULL DEFAULT 0,
                service_fee_bps INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (requester, request_id)
            )",
        );

        // Migration: add fee columns if missing (for existing DBs)
        let _ = conn.execute_batch(
            "ALTER TABLE redemption_requested_events ADD COLUMN service_fee_base INTEGER NOT NULL DEFAULT 0",
        );
        let _ = conn.execute_batch(
            "ALTER TABLE redemption_requested_events ADD COLUMN service_fee_bps INTEGER NOT NULL DEFAULT 0",
        );

        // Redemption processing events table (mark_processing, 0x0A)
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS redemption_processing_events (
                request_id INTEGER NOT NULL,
                requester TEXT NOT NULL,
                amount_sats INTEGER NOT NULL,
                processing_slot INTEGER NOT NULL,
                tx_signature TEXT NOT NULL,
                slot INTEGER NOT NULL,
                block_time INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (requester, request_id)
            )",
        );

        // Add instruction_disc column to nullifier_events (Aegis instruction discriminator)
        let _ = conn.execute_batch(
            "ALTER TABLE nullifier_events ADD COLUMN instruction_disc INTEGER",
        );

        // Add unshield token transfer columns to nullifier_events
        let _ = conn.execute_batch(
            "ALTER TABLE nullifier_events ADD COLUMN unshield_amount INTEGER",
        );
        let _ = conn.execute_batch(
            "ALTER TABLE nullifier_events ADD COLUMN unshield_recipient TEXT",
        );

        // Add transfer_type column to nullifier_events (event-first classification)
        let _ = conn.execute_batch(
            "ALTER TABLE nullifier_events ADD COLUMN transfer_type TEXT",
        );

        // Add token_id column to nullifier_events (from UnshieldMeta event)
        let _ = conn.execute_batch(
            "ALTER TABLE nullifier_events ADD COLUMN token_id TEXT",
        );

        // Add unshield fee/payout columns (from UnshieldMeta v2 event)
        let _ = conn.execute_batch(
            "ALTER TABLE nullifier_events ADD COLUMN unshield_fee INTEGER",
        );
        let _ = conn.execute_batch(
            "ALTER TABLE nullifier_events ADD COLUMN unshield_payout INTEGER",
        );

        // Add unshield output count (number of UnshieldMeta events per tx)
        let _ = conn.execute_batch(
            "ALTER TABLE nullifier_events ADD COLUMN unshield_output_count INTEGER",
        );

        // Add unshield_outputs JSON array for multi-output detail
        let _ = conn.execute_batch(
            "ALTER TABLE nullifier_events ADD COLUMN unshield_outputs TEXT",
        );

        Ok(())
    }

    /// Insert a leaf event derived from a StealthAnnouncement.
    /// `created_at` is set to `block_time` (LeafInserted event no longer emitted).
    /// Returns true if inserted, false if duplicate.
    pub fn insert_leaf_from_announcement(
        &self,
        leaf_index: i64,
        commitment: &[u8; 32],
        tx_signature: &str,
        slot: i64,
        block_time: i64,
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        let result = conn.execute(
            "INSERT INTO leaf_events (leaf_index, commitment, created_at, tx_signature, slot, block_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(leaf_index) DO UPDATE SET
                created_at = CASE WHEN excluded.block_time > 0 THEN excluded.block_time ELSE leaf_events.created_at END,
                block_time = CASE WHEN excluded.block_time > 0 THEN excluded.block_time ELSE leaf_events.block_time END",
            params![
                leaf_index,
                commitment.as_slice(),
                block_time, // created_at derived from block_time
                tx_signature,
                slot,
                block_time,
            ],
        );
        match result {
            Ok(n) => Ok(n > 0),
            Err(e) => Err(format!("insert leaf error: {}", e)),
        }
    }

    /// Insert a leaf from a seed file (localnet recovery).
    /// Minimal: only leaf_index + commitment, no tx signature or slot.
    pub fn insert_leaf_from_seed(
        &self,
        leaf_index: i64,
        commitment: &[u8; 32],
        source: &str,
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        let result = conn.execute(
            "INSERT OR IGNORE INTO leaf_events (leaf_index, commitment, created_at, tx_signature, slot, block_time)
             VALUES (?1, ?2, 0, ?3, 0, 0)",
            params![leaf_index, commitment.as_slice(), source],
        );
        match result {
            Ok(n) => Ok(n > 0),
            Err(e) => Err(format!("insert seed leaf error: {}", e)),
        }
    }

    /// Insert a nullifier event. Returns true if inserted, false if duplicate.
    pub fn insert_nullifier(
        &self,
        event: &NullifierSpentEvent,
        tx_signature: &str,
        slot: i64,
        block_time: i64,
        instruction_disc: Option<u8>,
        unshield_amount: Option<i64>,
        unshield_recipient: Option<&str>,
        transfer_type: Option<&str>,
        token_id: Option<&str>,
        unshield_fee: Option<i64>,
        unshield_payout: Option<i64>,
        unshield_output_count: Option<i64>,
        unshield_outputs_json: Option<&str>,
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        let result = conn.execute(
            "INSERT INTO nullifier_events (nullifier_hash, operation_type, spent_at, spent_by, tx_signature, slot, block_time, instruction_disc, unshield_amount, unshield_recipient, transfer_type, token_id, unshield_fee, unshield_payout, unshield_output_count, unshield_outputs)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(nullifier_hash) DO UPDATE SET
                spent_at = CASE WHEN excluded.block_time > 0 THEN excluded.block_time ELSE nullifier_events.spent_at END,
                block_time = CASE WHEN excluded.block_time > 0 THEN excluded.block_time ELSE nullifier_events.block_time END,
                instruction_disc = COALESCE(excluded.instruction_disc, nullifier_events.instruction_disc),
                unshield_amount = COALESCE(excluded.unshield_amount, nullifier_events.unshield_amount),
                unshield_recipient = COALESCE(excluded.unshield_recipient, nullifier_events.unshield_recipient),
                transfer_type = COALESCE(excluded.transfer_type, nullifier_events.transfer_type),
                token_id = COALESCE(excluded.token_id, nullifier_events.token_id),
                unshield_fee = COALESCE(excluded.unshield_fee, nullifier_events.unshield_fee),
                unshield_payout = COALESCE(excluded.unshield_payout, nullifier_events.unshield_payout),
                unshield_output_count = COALESCE(excluded.unshield_output_count, nullifier_events.unshield_output_count),
                unshield_outputs = COALESCE(excluded.unshield_outputs, nullifier_events.unshield_outputs)",
            params![
                event.nullifier_hash.as_slice(),
                event.operation_type as i64,
                block_time,
                tx_signature,
                tx_signature,
                slot,
                block_time,
                instruction_disc.map(|d| d as i64),
                unshield_amount,
                unshield_recipient,
                transfer_type,
                token_id,
                unshield_fee,
                unshield_payout,
                unshield_output_count,
                unshield_outputs_json,
            ],
        );
        match result {
            Ok(n) => Ok(n > 0),
            Err(e) => Err(format!("insert nullifier error: {}", e)),
        }
    }

    /// Insert a redemption completed event. Returns true if inserted, false if duplicate.
    pub fn insert_redemption_completed(
        &self,
        event: &RedemptionCompletedEvent,
        tx_signature: &str,
        slot: i64,
        block_time: i64,
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        // requester: base58, btc_txid: display hex (reversed)
        let requester = bs58::encode(&event.requester).into_string();
        let mut txid_display = event.btc_txid;
        txid_display.reverse();
        let btc_txid = hex::encode(txid_display);

        let result = conn.execute(
            "INSERT OR IGNORE INTO redemption_completed_events (request_id, requester, amount_sats, actual_received, service_fee, btc_txid, btc_script, tx_signature, slot, block_time, burn_amount, protocol_revenue)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                event.request_id as i64,
                requester,
                event.amount_sats as i64,
                event.actual_received as i64,
                event.service_fee as i64,
                btc_txid,
                event.btc_script.as_slice(),
                tx_signature,
                slot,
                block_time,
                event.burn_amount as i64,
                event.protocol_revenue as i64,
            ],
        );
        match result {
            Ok(n) => Ok(n > 0),
            Err(e) => Err(format!("insert redemption_completed error: {}", e)),
        }
    }

    /// Get all completed redemptions from on-chain events.
    pub fn get_completed_redemptions(&self) -> Result<Vec<RedemptionCompletedRow>, String> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT requester, amount_sats, actual_received, service_fee, request_id, btc_txid, btc_script, tx_signature, slot, block_time, burn_amount, protocol_revenue
                 FROM redemption_completed_events ORDER BY block_time DESC",
            )
            .map_err(|e| format!("query error: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let btc_script_blob: Vec<u8> = row.get(6)?;
                Ok(RedemptionCompletedRow {
                    requester: row.get(0)?,
                    amount_sats: row.get(1)?,
                    actual_received: row.get(2)?,
                    service_fee: row.get(3)?,
                    request_id: row.get(4)?,
                    btc_txid: row.get(5)?,
                    btc_script: hex::encode(btc_script_blob),
                    tx_signature: row.get(7)?,
                    burn_amount: row.get::<_, i64>(10).unwrap_or(0),
                    protocol_revenue: row.get::<_, i64>(11).unwrap_or(0),
                    slot: row.get(8)?,
                    block_time: row.get(9)?,
                })
            })
            .map_err(|e| format!("query error: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("row error: {}", e))
    }

    /// Insert a redemption requested event. Returns true if inserted, false if duplicate.
    pub fn insert_redemption_requested(
        &self,
        event: &RedemptionRequestedEvent,
        tx_signature: &str,
        slot: i64,
        block_time: i64,
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        let requester = bs58::encode(&event.requester).into_string();

        let result = conn.execute(
            "INSERT OR IGNORE INTO redemption_requested_events (request_id, requester, amount_sats, btc_script, tx_signature, slot, block_time, service_fee_base, service_fee_bps)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                event.request_id as i64,
                requester,
                event.amount_sats as i64,
                event.btc_script.as_slice(),
                tx_signature,
                slot,
                block_time,
                event.service_fee_base as i64,
                event.service_fee_bps as i64,
            ],
        );
        match result {
            Ok(n) => Ok(n > 0),
            Err(e) => Err(format!("insert redemption_requested error: {}", e)),
        }
    }

    /// Get all requested redemptions from on-chain events.
    pub fn get_requested_redemptions(&self) -> Result<Vec<RedemptionRequestedRow>, String> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT requester, amount_sats, request_id, btc_script, tx_signature, slot, block_time, service_fee_base, service_fee_bps
                 FROM redemption_requested_events ORDER BY block_time DESC",
            )
            .map_err(|e| format!("query error: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let btc_script_blob: Vec<u8> = row.get(3)?;
                Ok(RedemptionRequestedRow {
                    requester: row.get(0)?,
                    amount_sats: row.get(1)?,
                    request_id: row.get(2)?,
                    service_fee_base: row.get(7)?,
                    service_fee_bps: row.get(8)?,
                    btc_script: hex::encode(btc_script_blob),
                    tx_signature: row.get(4)?,
                    slot: row.get(5)?,
                    block_time: row.get(6)?,
                })
            })
            .map_err(|e| format!("query error: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("row error: {}", e))
    }

    /// Insert a redemption processing event. Returns true if inserted, false if duplicate.
    pub fn insert_redemption_processing(
        &self,
        event: &RedemptionProcessingEvent,
        tx_signature: &str,
        slot: i64,
        block_time: i64,
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        let requester = bs58::encode(&event.requester).into_string();

        let result = conn.execute(
            "INSERT OR IGNORE INTO redemption_processing_events (request_id, requester, amount_sats, processing_slot, tx_signature, slot, block_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event.request_id as i64,
                requester,
                event.amount_sats as i64,
                event.processing_slot as i64,
                tx_signature,
                slot,
                block_time,
            ],
        );
        match result {
            Ok(n) => Ok(n > 0),
            Err(e) => Err(format!("insert redemption_processing error: {}", e)),
        }
    }

    /// Get all processing redemptions from on-chain events.
    pub fn get_processing_redemptions(&self) -> Result<Vec<RedemptionProcessingRow>, String> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT requester, amount_sats, request_id, processing_slot, tx_signature, slot, block_time
                 FROM redemption_processing_events ORDER BY block_time DESC",
            )
            .map_err(|e| format!("query error: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(RedemptionProcessingRow {
                    requester: row.get(0)?,
                    amount_sats: row.get(1)?,
                    request_id: row.get(2)?,
                    processing_slot: row.get(3)?,
                    tx_signature: row.get(4)?,
                    slot: row.get(5)?,
                    block_time: row.get(6)?,
                })
            })
            .map_err(|e| format!("query error: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("row error: {}", e))
    }

    /// Get all leaves, optionally filtered by leaf_index > since.
    /// Enriches with announcement data (type, amount, ephemeral_pub) via LEFT JOIN.
    pub fn get_leaves(&self, since: Option<i64>) -> Result<Vec<LeafRow>, String> {
        let conn = self.conn()?;
        let base_query = "SELECT l.leaf_index, l.commitment, l.created_at, l.tx_signature, l.slot, \
                          a.announcement_type, a.encrypted_amount, a.ephemeral_pub, \
                          COALESCE(l.block_time, 0) as block_time \
                          FROM leaf_events l \
                          LEFT JOIN stealth_announcements a ON l.leaf_index = a.leaf_index";

        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<LeafRow> {
            let commitment_blob: Vec<u8> = row.get(1)?;
            let ann_type: Option<i64> = row.get(5)?;
            let encrypted_amount: Option<Vec<u8>> = row.get(6)?;
            let ephemeral_pub: Option<Vec<u8>> = row.get(7)?;
            let block_time: i64 = row.get(8)?;

            // For deposits (type=0), encrypted_amount is plaintext LE u64
            let amount_sats = if ann_type == Some(0) {
                encrypted_amount.as_ref().and_then(|b| {
                    if b.len() >= 8 {
                        Some(i64::from_le_bytes(b[..8].try_into().ok()?))
                    } else {
                        None
                    }
                })
            } else {
                None
            };

            Ok(LeafRow {
                leaf_index: row.get(0)?,
                commitment: hex::encode(&commitment_blob),
                // Use block_time (from RPC getTransaction) if available, fallback to created_at (from on-chain Clock)
                created_at: if block_time > 0 { block_time } else { row.get(2)? },
                tx_signature: row.get(3)?,
                slot: row.get(4)?,
                announcement_type: ann_type,
                amount_sats,
                ephemeral_pub: ephemeral_pub.map(|b| hex::encode(&b)),
            })
        };

        if let Some(since_idx) = since {
            let query = format!("{} WHERE l.leaf_index > ?1 ORDER BY l.leaf_index", base_query);
            let mut stmt = conn.prepare(&query).map_err(|e| format!("query error: {}", e))?;
            let rows = stmt.query_map(params![since_idx], map_row)
                .map_err(|e| format!("query error: {}", e))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))
        } else {
            let query = format!("{} ORDER BY l.leaf_index", base_query);
            let mut stmt = conn.prepare(&query).map_err(|e| format!("query error: {}", e))?;
            let rows = stmt.query_map([], map_row)
                .map_err(|e| format!("query error: {}", e))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))
        }
    }

    /// Get the next expected leaf index (max + 1, or 0 if empty)
    pub fn get_next_leaf_index(&self) -> Result<i64, String> {
        let conn = self.conn()?;
        let max: Option<i64> = conn
            .query_row(
                "SELECT MAX(leaf_index) FROM leaf_events",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("query error: {}", e))?;
        Ok(max.map(|m| m + 1).unwrap_or(0))
    }

    /// Get nullifier metadata by hash (hex-encoded)
    pub fn get_nullifier(&self, nullifier_hash_hex: &str) -> Result<Option<NullifierRow>, String> {
        let hash_bytes = hex::decode(nullifier_hash_hex)
            .map_err(|e| format!("hex decode error: {}", e))?;
        let conn = self.conn()?;
        let result = conn
            .query_row(
                "SELECT nullifier_hash, operation_type, spent_at, spent_by, tx_signature, slot FROM nullifier_events WHERE nullifier_hash = ?1",
                params![hash_bytes],
                |row| {
                    let hash_blob: Vec<u8> = row.get(0)?;
                    Ok(NullifierRow {
                        nullifier_hash: hex::encode(&hash_blob),
                        operation_type: row.get(1)?,
                        spent_at: row.get(2)?,
                        spent_by: row.get(3)?,
                        tx_signature: row.get(4)?,
                        slot: row.get(5)?,
                    })
                },
            );

        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("query error: {}", e)),
        }
    }

    /// Get/set last processed signature for incremental indexing
    pub fn get_last_signature(&self) -> Result<Option<String>, String> {
        let conn = self.conn()?;
        let result = conn.query_row(
            "SELECT value FROM indexer_state WHERE key = 'last_signature'",
            [],
            |row| row.get(0),
        );
        match result {
            Ok(sig) => Ok(Some(sig)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("query error: {}", e)),
        }
    }

    pub fn set_last_signature(&self, signature: &str) -> Result<(), String> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO indexer_state (key, value) VALUES ('last_signature', ?1)",
            params![signature],
        )
        .map_err(|e| format!("update error: {}", e))?;
        Ok(())
    }

    pub fn insert_announcement(
        &self,
        event: &StealthAnnouncementEvent,
        tx_signature: &str,
        slot: i64,
        block_time: i64,
        is_verified: bool,
        btc_deposit_txid: Option<&str>,
        btc_sweep_txid: Option<&str>,
        btc_deposit_amount_sats: Option<i64>,
        deposit_gross_amount: Option<i64>,
        deposit_fee: Option<i64>,
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        // Use ON CONFLICT to upgrade is_verified from false→true (never downgrade).
        // This handles the case where WS inserts first (is_verified=false) and
        // the poll service later processes the same tx with is_verified=true.
        // Also update BTC txids and deposit amount if provided (non-null wins over null).
        let result = conn.execute(
            "INSERT INTO stealth_announcements
             (leaf_index, announcement_type, ephemeral_pub, encrypted_amount, commitment, tx_signature, slot, block_time, is_verified, btc_deposit_txid, btc_sweep_txid, btc_deposit_amount_sats, token_id, deposit_gross_amount, deposit_fee)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(leaf_index) DO UPDATE SET
                is_verified = MAX(stealth_announcements.is_verified, excluded.is_verified),
                block_time = CASE WHEN excluded.block_time > 0 THEN excluded.block_time ELSE stealth_announcements.block_time END,
                btc_deposit_txid = COALESCE(excluded.btc_deposit_txid, stealth_announcements.btc_deposit_txid),
                btc_sweep_txid = COALESCE(excluded.btc_sweep_txid, stealth_announcements.btc_sweep_txid),
                btc_deposit_amount_sats = COALESCE(excluded.btc_deposit_amount_sats, stealth_announcements.btc_deposit_amount_sats),
                token_id = COALESCE(excluded.token_id, stealth_announcements.token_id),
                deposit_gross_amount = COALESCE(excluded.deposit_gross_amount, stealth_announcements.deposit_gross_amount),
                deposit_fee = COALESCE(excluded.deposit_fee, stealth_announcements.deposit_fee)",
            params![
                event.leaf_index as i64,
                event.announcement_type as i64,
                event.ephemeral_pub.as_slice(),
                event.encrypted_amount.as_slice(),
                event.commitment.as_slice(),
                tx_signature,
                slot,
                block_time,
                is_verified as i64,
                btc_deposit_txid,
                btc_sweep_txid,
                btc_deposit_amount_sats,
                event.token_id.as_slice(),
                deposit_gross_amount,
                deposit_fee,
            ],
        );
        match result {
            Ok(n) => Ok(n > 0),
            Err(e) => Err(format!("insert announcement error: {}", e)),
        }
    }

    pub fn get_announcements(&self, since_leaf_index: Option<i64>) -> Result<Vec<AnnouncementRow>, String> {
        let conn = self.conn()?;
        if let Some(since) = since_leaf_index {
            let mut stmt = conn
                .prepare(
                    "SELECT leaf_index, announcement_type, ephemeral_pub, encrypted_amount, commitment, tx_signature, slot, COALESCE(block_time, 0), COALESCE(is_verified, 0), btc_deposit_txid, btc_sweep_txid, btc_deposit_amount_sats, token_id, deposit_gross_amount, deposit_fee
                     FROM stealth_announcements WHERE leaf_index > ?1 ORDER BY leaf_index",
                )
                .map_err(|e| format!("query error: {}", e))?;
            let rows = stmt
                .query_map(params![since], Self::map_announcement_row)
                .map_err(|e| format!("query error: {}", e))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT leaf_index, announcement_type, ephemeral_pub, encrypted_amount, commitment, tx_signature, slot, COALESCE(block_time, 0), COALESCE(is_verified, 0), btc_deposit_txid, btc_sweep_txid, btc_deposit_amount_sats, token_id, deposit_gross_amount, deposit_fee
                     FROM stealth_announcements ORDER BY leaf_index",
                )
                .map_err(|e| format!("query error: {}", e))?;
            let rows = stmt
                .query_map([], Self::map_announcement_row)
                .map_err(|e| format!("query error: {}", e))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))
        }
    }

    pub fn get_leaf_count(&self) -> Result<i64, String> {
        let conn = self.conn()?;
        conn.query_row("SELECT COUNT(*) FROM leaf_events", [], |row| row.get(0))
            .map_err(|e| format!("query error: {}", e))
    }

    /// Count of nullifier events
    pub fn get_nullifier_count(&self) -> Result<i64, String> {
        let conn = self.conn()?;
        conn.query_row("SELECT COUNT(*) FROM nullifier_events", [], |row| row.get(0))
            .map_err(|e| format!("query error: {}", e))
    }

    /// Count unshield/redeem nullifiers missing amount data (legacy/stale records)
    /// Count of deposit announcements (announcement_type = 0)
    pub fn get_deposit_count(&self) -> Result<i64, String> {
        let conn = self.conn()?;
        conn.query_row(
            "SELECT COUNT(*) FROM stealth_announcements WHERE announcement_type = 0",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("query error: {}", e))
    }

    pub fn get_announcement_count(&self) -> Result<i64, String> {
        let conn = self.conn()?;
        conn.query_row("SELECT COUNT(*) FROM stealth_announcements", [], |row| row.get(0))
            .map_err(|e| format!("query error: {}", e))
    }

    /// Aggregate shielded amounts per token_id from deposit announcements (type=0).
    /// Returns Vec<(token_id_hex, total_amount)>.
    /// For deposits, encrypted_amount is plaintext LE u64.
    pub fn get_token_tvl(&self) -> Result<Vec<(String, u64)>, String> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT COALESCE(hex(token_id), ''), encrypted_amount \
                 FROM stealth_announcements WHERE announcement_type = 0"
            )
            .map_err(|e| format!("prepare error: {}", e))?;

        let mut tvl_map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();

        let rows = stmt
            .query_map([], |row| {
                let token_hex: String = row.get(0)?;
                let amount_bytes: Vec<u8> = row.get(1)?;
                Ok((token_hex, amount_bytes))
            })
            .map_err(|e| format!("query error: {}", e))?;

        for row in rows {
            let (token_hex, amount_bytes) = row.map_err(|e| format!("row error: {}", e))?;
            // Decode LE u64 from encrypted_amount (plaintext for deposits)
            if amount_bytes.len() >= 8 {
                let amount = u64::from_le_bytes(amount_bytes[..8].try_into().unwrap_or([0; 8]));
                *tvl_map.entry(token_hex).or_insert(0) += amount;
            }
        }

        Ok(tvl_map.into_iter().collect())
    }

    pub fn get_latest_announcement_leaf_index(&self) -> Result<Option<i64>, String> {
        let conn = self.conn()?;
        conn.query_row("SELECT MAX(leaf_index) FROM stealth_announcements", [], |row| row.get(0))
            .map_err(|e| format!("query error: {}", e))
    }

    /// Get nullifier hashes with incremental sync support.
    /// Returns (hashes since slot, total count, latest slot in result).
    pub fn get_nullifier_hashes_since(&self, since_slot: Option<i64>) -> Result<(Vec<String>, usize, i64), String> {
        let conn = self.conn()?;

        // Total count (always full)
        let total: usize = conn
            .query_row("SELECT COUNT(*) FROM nullifier_events", [], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("count error: {}", e))? as usize;

        // Fetch hashes (optionally filtered by slot)
        let (query, use_param) = if since_slot.is_some() {
            ("SELECT nullifier_hash, slot FROM nullifier_events WHERE slot > ?1 ORDER BY slot", true)
        } else {
            ("SELECT nullifier_hash, slot FROM nullifier_events ORDER BY slot", false)
        };

        let mut stmt = conn.prepare(query).map_err(|e| format!("query error: {}", e))?;

        let mut hashes = Vec::new();
        let mut latest_slot: i64 = 0;

        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<(String, i64)> {
            let blob: Vec<u8> = row.get(0)?;
            let slot: i64 = row.get(1)?;
            Ok((hex::encode(&blob), slot))
        };

        let rows = if use_param {
            stmt.query_map(params![since_slot.unwrap()], map_row)
        } else {
            stmt.query_map([], map_row)
        }.map_err(|e| format!("query error: {}", e))?;

        for row in rows {
            let (hash, slot) = row.map_err(|e| format!("row error: {}", e))?;
            if slot > latest_slot { latest_slot = slot; }
            hashes.push(hash);
        }

        Ok((hashes, total, latest_slot))
    }

    /// Clear all indexed data (leaves, nullifiers, announcements, state).
    /// Used to force a full re-index from on-chain data.
    pub fn clear_all(&self) -> Result<(), String> {
        let conn = self.conn()?;
        conn.execute_batch(
            "DELETE FROM leaf_events;
             DELETE FROM nullifier_events;
             DELETE FROM stealth_announcements;
             DELETE FROM redemption_requested_events;
             DELETE FROM redemption_processing_events;
             DELETE FROM indexer_state;"
        )
        .map_err(|e| format!("clear error: {}", e))?;
        Ok(())
    }

    /// Get transfers: announcements (type=1) grouped by tx_signature,
    /// enriched with nullifier hashes and timestamp from nullifier_events.
    pub fn get_transfers(&self) -> Result<Vec<TransferRow>, String> {
        let partials = self.get_transfer_outputs()?;
        let mut results = self.enrich_with_nullifiers(partials)?;
        let orphans = self.get_orphan_nullifier_transfers()?;
        results.extend(orphans);
        results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        Ok(results)
    }

    /// Step 1: Get grouped outputs from type=1 announcements (with first token_id for display)
    fn get_transfer_outputs(&self) -> Result<Vec<PartialTransfer>, String> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT
                a.tx_signature,
                GROUP_CONCAT(HEX(a.commitment), ',') AS commitments,
                GROUP_CONCAT(a.leaf_index, ',') AS leaf_indices,
                COUNT(a.leaf_index) AS output_count,
                HEX(MIN(a.token_id)) AS token_id
             FROM stealth_announcements a
             WHERE a.announcement_type = 1
             GROUP BY a.tx_signature
             ORDER BY MAX(a.leaf_index) DESC"
        ).map_err(|e| format!("query error: {}", e))?;

        let rows = stmt.query_map([], |row| {
            let commitments_str: String = row.get(1)?;
            let leaf_indices_str: String = row.get(2)?;
            Ok(PartialTransfer {
                tx_signature: row.get(0)?,
                commitments: commitments_str.split(',').map(|s| s.to_lowercase()).collect(),
                leaf_indices: leaf_indices_str.split(',').filter_map(|s| s.parse().ok()).collect(),
                output_count: row.get(3)?,
                token_id: row.get::<_, Option<String>>(4).unwrap_or(None).map(|s| s.to_lowercase()),
            })
        }).map_err(|e| format!("query error: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))
    }

    /// Step 2: For each partial transfer, fetch nullifiers + block_time + operation_type +
    /// instruction_disc + unshield fields + transfer_type, and build TransferRow.
    fn enrich_with_nullifiers(&self, partials: Vec<PartialTransfer>) -> Result<Vec<TransferRow>, String> {
        let conn = self.conn()?;
        let mut null_stmt = conn.prepare(
            "SELECT HEX(nullifier_hash), spent_at, COALESCE(block_time, 0), operation_type, instruction_disc, unshield_amount, unshield_recipient, transfer_type, token_id, unshield_fee, unshield_payout, unshield_outputs FROM nullifier_events WHERE tx_signature = ?1"
        ).map_err(|e| format!("query error: {}", e))?;

        // Fallback: get block_time from announcements when nullifier block_time is 0
        let mut ann_time_stmt = conn.prepare(
            "SELECT COALESCE(MAX(block_time), 0) FROM stealth_announcements WHERE tx_signature = ?1"
        ).map_err(|e| format!("query error: {}", e))?;

        let mut results = Vec::with_capacity(partials.len());
        for p in partials {
            let nullifiers: Vec<NullRow> = null_stmt.query_map(
                params![p.tx_signature],
                |row| {
                    Ok(NullRow {
                        hash: row.get::<_, String>(0)?.to_lowercase(),
                        spent_at: row.get(1)?,
                        block_time: row.get(2)?,
                        op_type: row.get(3)?,
                        disc: row.get(4)?,
                        ua: row.get(5)?,
                        ur: row.get(6)?,
                        tt: row.get(7)?,
                        tid: row.get(8)?,
                        uf: row.get(9)?,
                        up: row.get(10)?,
                        uoutputs: row.get(11)?,
                    })
                },
            ).map_err(|e| format!("query error: {}", e))?
             .collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))?;

            let input_count = nullifiers.len() as i64;
            let block_time = nullifiers.iter().map(|n| n.block_time).max().unwrap_or(0);
            let spent_at = nullifiers.iter().map(|n| n.spent_at).max().unwrap_or(0);
            // Fallback chain: nullifier block_time -> nullifier spent_at -> announcement block_time
            let timestamp = if block_time > 0 {
                block_time
            } else if spent_at > 0 {
                spent_at
            } else {
                // Last resort: use announcement block_time for this tx
                ann_time_stmt.query_row(params![p.tx_signature], |row| row.get::<_, i64>(0)).unwrap_or(0)
            };
            let operation_type = nullifiers.first().map(|n| n.op_type).unwrap_or(2);
            let instruction_disc = nullifiers.first().and_then(|n| n.disc);
            // For multi-output unshield: sum amounts across all nullifiers
            let unshield_amount: Option<i64> = {
                let sum: i64 = nullifiers.iter().filter_map(|n| n.ua).sum();
                if sum > 0 { Some(sum) } else { nullifiers.first().and_then(|n| n.ua) }
            };
            let unshield_recipient = nullifiers.first().and_then(|n| n.ur.clone());
            let transfer_type = nullifiers.first().and_then(|n| n.tt.clone())
                .unwrap_or_else(|| "private_transfer".to_string());
            // Prefer nullifier's token_id (from UnshieldMeta event) over announcement's
            let nullifier_token_id = nullifiers.first().and_then(|n| n.tid.clone());
            let unshield_fee: Option<i64> = {
                let sum: i64 = nullifiers.iter().filter_map(|n| n.uf).sum();
                if sum > 0 { Some(sum) } else { nullifiers.first().and_then(|n| n.uf) }
            };
            let unshield_payout: Option<i64> = {
                let sum: i64 = nullifiers.iter().filter_map(|n| n.up).sum();
                if sum > 0 { Some(sum) } else { nullifiers.first().and_then(|n| n.up) }
            };
            let unshield_outputs: Option<Vec<serde_json::Value>> = nullifiers.first()
                .and_then(|n| n.uoutputs.as_ref())
                .and_then(|s| serde_json::from_str(s).ok());
            let nullifier_hashes: Vec<String> = nullifiers.into_iter().map(|n| n.hash).collect();

            let status = if timestamp > 0 { "confirmed".to_string() } else { "processing".to_string() };
            results.push(TransferRow {
                tx_signature: p.tx_signature,
                commitments: p.commitments,
                leaf_indices: p.leaf_indices,
                nullifier_hashes,
                output_count: p.output_count,
                input_count,
                timestamp,
                status,
                operation_type,
                instruction_disc,
                unshield_amount,
                unshield_recipient,
                token_id: nullifier_token_id.or(p.token_id),
                transfer_type,
                unshield_fee,
                unshield_payout,
                unshield_outputs,
            });
        }

        Ok(results)
    }

    /// Step 3: Find orphan nullifier events -- tx_signatures that have nullifiers
    /// but NO type=1 stealth announcements. These are either:
    ///   - Unshield (disc=15/30): shielded -> SPL token (show amount/recipient)
    ///   - Private transfer (disc=14): JoinSplit whose announcements are in another tx
    /// Excludes request_redemption (disc=5) and redeem (disc=16) which belong in Withdrawals.
    fn get_orphan_nullifier_transfers(&self) -> Result<Vec<TransferRow>, String> {
        let conn = self.conn()?;
        let mut orphan_stmt = conn.prepare(
            "SELECT n.tx_signature,
                    GROUP_CONCAT(HEX(n.nullifier_hash), ',') AS hashes,
                    COUNT(*) AS input_count,
                    MIN(n.operation_type) AS op_type,
                    MAX(n.spent_at) AS spent_at,
                    MAX(COALESCE(n.block_time, 0)) AS block_time,
                    MAX(n.unshield_amount) AS unshield_amount,
                    MAX(n.unshield_recipient) AS unshield_recipient,
                    MAX(n.instruction_disc) AS disc,
                    MAX(n.transfer_type) AS ttype,
                    MAX(n.token_id) AS tid,
                    MAX(n.unshield_fee) AS ufee,
                    MAX(n.unshield_payout) AS upayout,
                    MAX(n.unshield_output_count) AS uoutcnt,
                    MAX(n.unshield_outputs) AS uoutputs
             FROM nullifier_events n
             WHERE n.tx_signature NOT IN (
                 SELECT DISTINCT tx_signature FROM stealth_announcements WHERE announcement_type = 1
             )
             AND COALESCE(n.instruction_disc, -1) NOT IN (5, 16, 17)
             GROUP BY n.tx_signature
             ORDER BY MAX(COALESCE(n.block_time, n.spent_at)) DESC"
        ).map_err(|e| format!("query error: {}", e))?;

        let rows = orphan_stmt.query_map([], |row| {
            let tx_sig: String = row.get(0)?;
            let hashes_str: String = row.get(1)?;
            let input_count: i64 = row.get(2)?;
            let op_type: i64 = row.get(3)?;
            let spent_at: i64 = row.get(4)?;
            let block_time: i64 = row.get(5)?;
            let unshield_amount: Option<i64> = row.get(6)?;
            let unshield_recipient: Option<String> = row.get(7)?;
            let disc: Option<i64> = row.get(8)?;
            let ttype: Option<String> = row.get(9)?;
            let tid: Option<String> = row.get(10)?;
            let ufee: Option<i64> = row.get(11)?;
            let upayout: Option<i64> = row.get(12)?;
            let uoutcnt: Option<i64> = row.get(13)?;
            let uoutputs_str: Option<String> = row.get(14)?;
            let unshield_outputs: Option<Vec<serde_json::Value>> = uoutputs_str
                .and_then(|s| serde_json::from_str(&s).ok());
            let ts = if block_time > 0 { block_time } else { spent_at };

            // Use actual disc/transfer_type from DB; disc=14(unshield), 15(redeem/old unshield), 30(legacy)
            let actual_disc = disc.map(|d| d as i64);
            let is_unshield = matches!(actual_disc, Some(14) | Some(15) | Some(30))
                || ttype.as_deref() == Some("unshield") || ttype.as_deref() == Some("redeem");
            let transfer_type = ttype.unwrap_or_else(|| {
                if is_unshield { "unshield".to_string() } else { "private_transfer".to_string() }
            });

            Ok(TransferRow {
                tx_signature: tx_sig,
                commitments: vec![],
                leaf_indices: vec![],
                nullifier_hashes: hashes_str.split(',').map(|s| s.to_lowercase()).collect(),
                output_count: if is_unshield { uoutcnt.unwrap_or(1) } else { 0 },
                input_count,
                timestamp: ts,
                status: if ts > 0 { "confirmed".to_string() } else { "processing".to_string() },
                operation_type: op_type,
                instruction_disc: actual_disc.map(|d| d as i64),
                unshield_amount: if is_unshield { unshield_amount } else { None },
                unshield_recipient: if is_unshield { unshield_recipient } else { None },
                token_id: tid,
                transfer_type,
                unshield_fee: if is_unshield { ufee } else { None },
                unshield_payout: if is_unshield { upayout } else { None },
                unshield_outputs: if is_unshield { unshield_outputs } else { None },
            })
        }).map_err(|e| format!("query error: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))
    }

    fn map_announcement_row(row: &rusqlite::Row) -> rusqlite::Result<AnnouncementRow> {
        let ephemeral_blob: Vec<u8> = row.get(2)?;
        let amount_blob: Vec<u8> = row.get(3)?;
        let commitment_blob: Vec<u8> = row.get(4)?;
        let token_id_blob: Vec<u8> = row.get(12)?;
        Ok(AnnouncementRow {
            leaf_index: row.get(0)?,
            announcement_type: row.get(1)?,
            ephemeral_pub: hex::encode(&ephemeral_blob),
            encrypted_amount: hex::encode(&amount_blob),
            commitment: hex::encode(&commitment_blob),
            tx_signature: row.get(5)?,
            slot: row.get(6)?,
            block_time: row.get::<_, i64>(7).unwrap_or(0),
            is_verified: row.get::<_, i64>(8).unwrap_or(0) != 0,
            btc_deposit_txid: row.get::<_, Option<String>>(9).unwrap_or(None),
            btc_sweep_txid: row.get::<_, Option<String>>(10).unwrap_or(None),
            btc_deposit_amount_sats: row.get::<_, Option<i64>>(11).unwrap_or(None),
            token_id: hex::encode(&token_id_blob),
            deposit_gross_amount: row.get::<_, Option<i64>>(13).unwrap_or(None),
            deposit_fee: row.get::<_, Option<i64>>(14).unwrap_or(None),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_insert_and_query_leaves() {
        let store = EventStore::in_memory().unwrap();

        let commitment = [0xAB; 32];

        assert!(store.insert_leaf_from_announcement(0, &commitment, "sig1", 100, 1700000000).unwrap());
        // ON CONFLICT DO UPDATE still returns true (row affected), but no new row created
        assert!(store.insert_leaf_from_announcement(0, &commitment, "sig1", 100, 1700000000).unwrap());

        let leaves = store.get_leaves(None).unwrap();
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].leaf_index, 0);
        assert_eq!(leaves[0].created_at, 1700000000);

        // Verify WS→poll upgrade: insert with block_time=0 (WS), then upgrade with real time
        assert!(store.insert_leaf_from_announcement(1, &commitment, "sig2", 101, 0).unwrap());
        let leaves = store.get_leaves(None).unwrap();
        assert_eq!(leaves[1].created_at, 0);
        // Poll service re-inserts with real block_time → upgrades
        assert!(store.insert_leaf_from_announcement(1, &commitment, "sig2", 101, 1700001000).unwrap());
        let leaves = store.get_leaves(None).unwrap();
        assert_eq!(leaves[1].created_at, 1700001000);

        assert_eq!(store.get_next_leaf_index().unwrap(), 2);
    }

    #[test]
    fn test_insert_and_query_announcements() {
        let store = EventStore::in_memory().unwrap();
        let event = StealthAnnouncementEvent {
            announcement_type: 1,
            ephemeral_pub: [0xAA; 32],
            encrypted_amount: [0x01; 8],
            commitment: [0xBB; 32],
            leaf_index: 5,
            token_id: [0xCC; 32],
        };
        assert!(store.insert_announcement(&event, "sig1", 100, 1700000000, false, None, None, None, None, None).unwrap());
        // Second insert with same leaf_index uses ON CONFLICT DO UPDATE (returns rows_affected > 0)
        // but no new row is created
        let _ = store.insert_announcement(&event, "sig1", 100, 1700000000, false, None, None, None, None, None).unwrap();

        let rows = store.get_announcements(None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].leaf_index, 5);
        assert_eq!(rows[0].announcement_type, 1);

        let rows_since = store.get_announcements(Some(5)).unwrap();
        assert_eq!(rows_since.len(), 0);

        assert_eq!(store.get_announcement_count().unwrap(), 1);
        assert_eq!(store.get_latest_announcement_leaf_index().unwrap(), Some(5));
    }

    #[test]
    fn test_insert_and_query_nullifier() {
        let store = EventStore::in_memory().unwrap();

        let event = NullifierSpentEvent {
            nullifier_hash: [0xCD; 32],
            operation_type: 2,
            instruction_disc: 14,
        };

        assert!(store.insert_nullifier(&event, "sig2", 101, 1700000001, Some(14), None, None, Some("private_transfer"), None, None, None, None, None).unwrap());

        let hash_hex = hex::encode([0xCD; 32]);
        let result = store.get_nullifier(&hash_hex).unwrap();
        assert!(result.is_some());
        let row = result.unwrap();
        assert_eq!(row.operation_type, 2);
        assert_eq!(row.spent_at, 1700000001);
    }
}
