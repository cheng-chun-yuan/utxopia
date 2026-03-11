//! SQLite storage for indexed events

use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;
use std::path::Path;

use super::parser::{LeafInsertedEvent, NullifierSpentEvent, StealthAnnouncementEvent};

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
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        let spent_by_hex = hex::encode(&event.spent_by);
        let result = conn.execute(
            "INSERT OR IGNORE INTO nullifier_events (nullifier_hash, operation_type, spent_at, spent_by, tx_signature, slot, block_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event.nullifier_hash.as_slice(),
                event.operation_type as i64,
                event.spent_at,
                spent_by_hex,
                tx_signature,
                slot,
                block_time,
            ],
        );
        match result {
            Ok(n) => Ok(n > 0),
            Err(e) => Err(format!("insert nullifier error: {}", e)),
        }
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
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        let result = conn.execute(
            "INSERT OR IGNORE INTO stealth_announcements
             (leaf_index, announcement_type, ephemeral_pub, encrypted_amount, commitment, tx_signature, slot, block_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                event.leaf_index as i64,
                event.announcement_type as i64,
                event.ephemeral_pub.as_slice(),
                event.encrypted_amount.as_slice(),
                event.commitment.as_slice(),
                tx_signature,
                slot,
                block_time,
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
                    "SELECT leaf_index, announcement_type, ephemeral_pub, encrypted_amount, commitment, tx_signature, slot, COALESCE(block_time, 0)
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
                    "SELECT leaf_index, announcement_type, ephemeral_pub, encrypted_amount, commitment, tx_signature, slot, COALESCE(block_time, 0)
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

        // Step 2: For each tx, fetch nullifiers + block_time
        let mut null_stmt = conn.prepare(
            "SELECT HEX(nullifier_hash), spent_at, COALESCE(block_time, 0) FROM nullifier_events WHERE tx_signature = ?1"
        ).map_err(|e| format!("query error: {}", e))?;

        let mut results = Vec::with_capacity(partials.len());
        for p in partials {
            let nullifiers: Vec<(String, i64, i64)> = null_stmt.query_map(
                params![p.tx_signature],
                |row| {
                    let hash: String = row.get(0)?;
                    let spent_at: i64 = row.get(1)?;
                    let block_time: i64 = row.get(2)?;
                    Ok((hash.to_lowercase(), spent_at, block_time))
                },
            ).map_err(|e| format!("query error: {}", e))?
             .collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))?;

            let input_count = nullifiers.len() as i64;
            // Prefer block_time (from RPC), fall back to spent_at (from on-chain Clock)
            let block_time = nullifiers.iter().map(|(_, _, bt)| *bt).max().unwrap_or(0);
            let spent_at = nullifiers.iter().map(|(_, t, _)| *t).max().unwrap_or(0);
            let timestamp = if block_time > 0 { block_time } else { spent_at };
            let nullifier_hashes: Vec<String> = nullifiers.into_iter().map(|(h, _, _)| h).collect();

            results.push(TransferRow {
                tx_signature: p.tx_signature,
                commitments: p.commitments,
                leaf_indices: p.leaf_indices,
                nullifier_hashes,
                output_count: p.output_count,
                input_count,
                timestamp,
            });
        }

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
        assert!(store.insert_announcement(&event, "sig1", 100, 1700000000).unwrap());
        assert!(!store.insert_announcement(&event, "sig1", 100, 1700000000).unwrap()); // dup

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

        assert!(store.insert_nullifier(&event, "sig2", 101, 1700000001).unwrap());

        let hash_hex = hex::encode([0xCD; 32]);
        let result = store.get_nullifier(&hash_hex).unwrap();
        assert!(result.is_some());
        let row = result.unwrap();
        assert_eq!(row.operation_type, 2);
        assert_eq!(row.spent_at, 1700000001);
    }
}
