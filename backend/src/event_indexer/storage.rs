//! SQLite storage for indexed events

use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;
use std::path::Path;

use super::parser::{LeafInsertedEvent, NullifierSpentEvent, RedemptionCompletedEvent, RedemptionProcessingEvent, RedemptionRequestedEvent, StealthAnnouncementEvent};

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
    /// NullifierOperationType: 0=FullWithdrawal (unshield/redeem), 1=PartialWithdrawal, 2=PrivateTransfer
    pub operation_type: i64,
    /// Aegis instruction discriminator: 14=transact, 15=unshield, 5=request_redemption, 16=redeem
    pub instruction_disc: Option<i64>,
    /// Token transfer amount in sats (unshield txs only)
    pub unshield_amount: Option<i64>,
    /// Token transfer recipient wallet (unshield txs only)
    pub unshield_recipient: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AnnouncementRow {
    pub leaf_index: i64,
    pub announcement_type: i64,
    pub ephemeral_pub: String,   // hex
    pub encrypted_amount: String, // hex
    pub commitment: String,       // hex
    pub tx_signature: String,
    pub slot: i64,
    /// Block time from getTransaction RPC (Unix timestamp)
    pub block_time: i64,
    /// Whether this deposit was SPV-verified (real BTC deposit vs demo)
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
}

/// A completed redemption row (from on-chain event 0x07)
#[derive(Debug, Clone, serde::Serialize)]
pub struct RedemptionCompletedRow {
    pub requester: String,     // base58
    pub amount_sats: i64,
    pub request_id: i64,
    pub btc_txid: String,      // display hex (reversed)
    pub btc_script: String,    // hex
    pub tx_signature: String,  // Solana tx sig
    pub slot: i64,
    pub block_time: i64,
}

/// A requested redemption row (from on-chain event 0x08)
#[derive(Debug, Clone, serde::Serialize)]
pub struct RedemptionRequestedRow {
    pub requester: String,     // base58
    pub amount_sats: i64,
    pub request_id: i64,
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
                block_time INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS stealth_announcements (
                leaf_index INTEGER PRIMARY KEY,
                announcement_type INTEGER NOT NULL,
                ephemeral_pub BLOB NOT NULL,
                encrypted_amount BLOB NOT NULL,
                commitment BLOB NOT NULL,
                tx_signature TEXT NOT NULL,
                slot INTEGER NOT NULL,
                block_time INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS indexer_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );


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

        // Redemption completed events table
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS redemption_completed_events (
                request_id INTEGER PRIMARY KEY,
                requester TEXT NOT NULL,
                amount_sats INTEGER NOT NULL,
                btc_txid TEXT NOT NULL,
                btc_script BLOB NOT NULL,
                tx_signature TEXT NOT NULL,
                slot INTEGER NOT NULL,
                block_time INTEGER NOT NULL DEFAULT 0
            )",
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
                PRIMARY KEY (requester, request_id)
            )",
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

        Ok(())
    }

    /// Insert a leaf event. Returns true if inserted, false if duplicate.
    pub fn insert_leaf(
        &self,
        leaf_index: i64,
        event: &LeafInsertedEvent,
        tx_signature: &str,
        slot: i64,
        block_time: i64,
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        let result = conn.execute(
            "INSERT OR IGNORE INTO leaf_events (leaf_index, commitment, created_at, tx_signature, slot, block_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                leaf_index,
                event.commitment.as_slice(),
                event.created_at,
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
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        let spent_by_hex = hex::encode(&event.spent_by);
        let result = conn.execute(
            "INSERT OR IGNORE INTO nullifier_events (nullifier_hash, operation_type, spent_at, spent_by, tx_signature, slot, block_time, instruction_disc, unshield_amount, unshield_recipient)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                event.nullifier_hash.as_slice(),
                event.operation_type as i64,
                event.spent_at,
                spent_by_hex,
                tx_signature,
                slot,
                block_time,
                instruction_disc.map(|d| d as i64),
                unshield_amount,
                unshield_recipient,
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
            "INSERT OR IGNORE INTO redemption_completed_events (request_id, requester, amount_sats, btc_txid, btc_script, tx_signature, slot, block_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                event.request_id as i64,
                requester,
                event.amount_sats as i64,
                btc_txid,
                event.btc_script.as_slice(),
                tx_signature,
                slot,
                block_time,
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
                "SELECT requester, amount_sats, request_id, btc_txid, btc_script, tx_signature, slot, block_time
                 FROM redemption_completed_events ORDER BY block_time DESC",
            )
            .map_err(|e| format!("query error: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let btc_script_blob: Vec<u8> = row.get(4)?;
                Ok(RedemptionCompletedRow {
                    requester: row.get(0)?,
                    amount_sats: row.get(1)?,
                    request_id: row.get(2)?,
                    btc_txid: row.get(3)?,
                    btc_script: hex::encode(btc_script_blob),
                    tx_signature: row.get(5)?,
                    slot: row.get(6)?,
                    block_time: row.get(7)?,
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
            "INSERT OR IGNORE INTO redemption_requested_events (request_id, requester, amount_sats, btc_script, tx_signature, slot, block_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event.request_id as i64,
                requester,
                event.amount_sats as i64,
                event.btc_script.as_slice(),
                tx_signature,
                slot,
                block_time,
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
                "SELECT requester, amount_sats, request_id, btc_script, tx_signature, slot, block_time
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
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        // Use ON CONFLICT to upgrade is_verified from false→true (never downgrade).
        // This handles the case where WS inserts first (is_verified=false) and
        // the poll service later processes the same tx with is_verified=true.
        // Also update BTC txids and deposit amount if provided (non-null wins over null).
        let result = conn.execute(
            "INSERT INTO stealth_announcements
             (leaf_index, announcement_type, ephemeral_pub, encrypted_amount, commitment, tx_signature, slot, block_time, is_verified, btc_deposit_txid, btc_sweep_txid, btc_deposit_amount_sats)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(leaf_index) DO UPDATE SET
                is_verified = MAX(stealth_announcements.is_verified, excluded.is_verified),
                block_time = CASE WHEN excluded.block_time > 0 THEN excluded.block_time ELSE stealth_announcements.block_time END,
                btc_deposit_txid = COALESCE(excluded.btc_deposit_txid, stealth_announcements.btc_deposit_txid),
                btc_sweep_txid = COALESCE(excluded.btc_sweep_txid, stealth_announcements.btc_sweep_txid),
                btc_deposit_amount_sats = COALESCE(excluded.btc_deposit_amount_sats, stealth_announcements.btc_deposit_amount_sats)",
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
                    "SELECT leaf_index, announcement_type, ephemeral_pub, encrypted_amount, commitment, tx_signature, slot, COALESCE(block_time, 0), COALESCE(is_verified, 0), btc_deposit_txid, btc_sweep_txid, btc_deposit_amount_sats
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
                    "SELECT leaf_index, announcement_type, ephemeral_pub, encrypted_amount, commitment, tx_signature, slot, COALESCE(block_time, 0), COALESCE(is_verified, 0), btc_deposit_txid, btc_sweep_txid, btc_deposit_amount_sats
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
        let conn = self.conn()?;

        // Step 1: Get grouped outputs
        let mut stmt = conn.prepare(
            "SELECT
                a.tx_signature,
                GROUP_CONCAT(HEX(a.commitment), ',') AS commitments,
                GROUP_CONCAT(a.leaf_index, ',') AS leaf_indices,
                COUNT(a.leaf_index) AS output_count
             FROM stealth_announcements a
             WHERE a.announcement_type = 1
             GROUP BY a.tx_signature
             ORDER BY MAX(a.leaf_index) DESC"
        ).map_err(|e| format!("query error: {}", e))?;

        struct PartialTransfer {
            tx_signature: String,
            commitments: Vec<String>,
            leaf_indices: Vec<i64>,
            output_count: i64,
        }

        let partials: Vec<PartialTransfer> = stmt.query_map([], |row| {
            let commitments_str: String = row.get(1)?;
            let leaf_indices_str: String = row.get(2)?;
            Ok(PartialTransfer {
                tx_signature: row.get(0)?,
                commitments: commitments_str.split(',').map(|s| s.to_lowercase()).collect(),
                leaf_indices: leaf_indices_str.split(',').filter_map(|s| s.parse().ok()).collect(),
                output_count: row.get(3)?,
            })
        }).map_err(|e| format!("query error: {}", e))?
          .collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))?;

        // Step 2: For each tx, fetch nullifiers + block_time + operation_type + instruction_disc + unshield fields
        let mut null_stmt = conn.prepare(
            "SELECT HEX(nullifier_hash), spent_at, COALESCE(block_time, 0), operation_type, instruction_disc, unshield_amount, unshield_recipient FROM nullifier_events WHERE tx_signature = ?1"
        ).map_err(|e| format!("query error: {}", e))?;

        let mut results = Vec::with_capacity(partials.len());
        for p in partials {
            let nullifiers: Vec<(String, i64, i64, i64, Option<i64>, Option<i64>, Option<String>)> = null_stmt.query_map(
                params![p.tx_signature],
                |row| {
                    let hash: String = row.get(0)?;
                    let spent_at: i64 = row.get(1)?;
                    let block_time: i64 = row.get(2)?;
                    let op_type: i64 = row.get(3)?;
                    let disc: Option<i64> = row.get(4)?;
                    let ua: Option<i64> = row.get(5)?;
                    let ur: Option<String> = row.get(6)?;
                    Ok((hash.to_lowercase(), spent_at, block_time, op_type, disc, ua, ur))
                },
            ).map_err(|e| format!("query error: {}", e))?
             .collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))?;

            let input_count = nullifiers.len() as i64;
            let block_time = nullifiers.iter().map(|(_, _, bt, _, _, _, _)| *bt).max().unwrap_or(0);
            let spent_at = nullifiers.iter().map(|(_, t, _, _, _, _, _)| *t).max().unwrap_or(0);
            let timestamp = if block_time > 0 { block_time } else { spent_at };
            let operation_type = nullifiers.first().map(|(_, _, _, ot, _, _, _)| *ot).unwrap_or(2);
            let instruction_disc = nullifiers.first().and_then(|(_, _, _, _, d, _, _)| *d);
            let unshield_amount = nullifiers.first().and_then(|(_, _, _, _, _, ua, _)| *ua);
            let unshield_recipient = nullifiers.first().and_then(|(_, _, _, _, _, _, ur)| ur.clone());
            let nullifier_hashes: Vec<String> = nullifiers.into_iter().map(|(h, _, _, _, _, _, _)| h).collect();

            results.push(TransferRow {
                tx_signature: p.tx_signature,
                commitments: p.commitments,
                leaf_indices: p.leaf_indices,
                nullifier_hashes,
                output_count: p.output_count,
                input_count,
                timestamp,
                operation_type,
                instruction_disc,
                unshield_amount,
                unshield_recipient,
            });
        }

        // Step 3: Find unshield transactions — nullifier events whose
        // tx_signature does NOT appear in transfer announcements (no type=1 outputs),
        // and instruction_disc = 15 (UNSHIELD). Excludes request_redemption (disc=5)
        // and redeem (disc=16) which belong in the Withdrawals tab.
        let mut unshield_stmt = conn.prepare(
            "SELECT n.tx_signature,
                    GROUP_CONCAT(HEX(n.nullifier_hash), ',') AS hashes,
                    COUNT(*) AS input_count,
                    MIN(n.operation_type) AS op_type,
                    MAX(n.spent_at) AS spent_at,
                    MAX(COALESCE(n.block_time, 0)) AS block_time,
                    MAX(n.unshield_amount) AS unshield_amount,
                    MAX(n.unshield_recipient) AS unshield_recipient
             FROM nullifier_events n
             WHERE n.tx_signature NOT IN (
                 SELECT DISTINCT tx_signature FROM stealth_announcements WHERE announcement_type = 1
             )
             AND COALESCE(n.instruction_disc, -1) NOT IN (5, 16, 17)
             GROUP BY n.tx_signature
             ORDER BY MAX(COALESCE(n.block_time, n.spent_at)) DESC"
        ).map_err(|e| format!("query error: {}", e))?;

        let unshields: Vec<TransferRow> = unshield_stmt.query_map([], |row| {
            let tx_sig: String = row.get(0)?;
            let hashes_str: String = row.get(1)?;
            let input_count: i64 = row.get(2)?;
            let op_type: i64 = row.get(3)?;
            let spent_at: i64 = row.get(4)?;
            let block_time: i64 = row.get(5)?;
            let unshield_amount: Option<i64> = row.get(6)?;
            let unshield_recipient: Option<String> = row.get(7)?;
            Ok(TransferRow {
                tx_signature: tx_sig,
                commitments: vec![],
                leaf_indices: vec![],
                nullifier_hashes: hashes_str.split(',').map(|s| s.to_lowercase()).collect(),
                output_count: 0,
                input_count,
                timestamp: if block_time > 0 { block_time } else { spent_at },
                operation_type: op_type,
                instruction_disc: Some(15), // unshield
                unshield_amount,
                unshield_recipient,
            })
        }).map_err(|e| format!("query error: {}", e))?
          .collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))?;

        results.extend(unshields);
        // Re-sort by timestamp descending
        results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

        Ok(results)
    }

    fn map_announcement_row(row: &rusqlite::Row) -> rusqlite::Result<AnnouncementRow> {
        let ephemeral_blob: Vec<u8> = row.get(2)?;
        let amount_blob: Vec<u8> = row.get(3)?;
        let commitment_blob: Vec<u8> = row.get(4)?;
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
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_insert_and_query_leaves() {
        let store = EventStore::in_memory().unwrap();

        let event = LeafInsertedEvent {
            commitment: [0xAB; 32],
            created_at: 1700000000,
        };

        assert!(store.insert_leaf(0, &event, "sig1", 100, 1700000000).unwrap());
        assert!(!store.insert_leaf(0, &event, "sig1", 100, 1700000000).unwrap()); // duplicate

        let leaves = store.get_leaves(None).unwrap();
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].leaf_index, 0);
        assert_eq!(leaves[0].created_at, 1700000000);

        assert_eq!(store.get_next_leaf_index().unwrap(), 1);
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
        };
        assert!(store.insert_announcement(&event, "sig1", 100, 1700000000, false, None, None, None).unwrap());
        // Second insert with same leaf_index uses ON CONFLICT DO UPDATE (returns rows_affected > 0)
        // but no new row is created
        let _ = store.insert_announcement(&event, "sig1", 100, 1700000000, false, None, None, None).unwrap();

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
            spent_at: 1700000001,
            spent_by: [0xEF; 32],
        };

        assert!(store.insert_nullifier(&event, "sig2", 101, 1700000001, Some(14), None, None).unwrap());

        let hash_hex = hex::encode([0xCD; 32]);
        let result = store.get_nullifier(&hash_hex).unwrap();
        assert!(result.is_some());
        let row = result.unwrap();
        assert_eq!(row.operation_type, 2);
        assert_eq!(row.spent_at, 1700000001);
    }
}
