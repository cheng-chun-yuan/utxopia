//! SQLite storage for indexed events

use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;
use std::path::Path;

use super::parser::{LeafInsertedEvent, NullifierSpentEvent};

/// SQLite-backed event store
pub struct EventStore {
    pool: Pool<SqliteConnectionManager>,
}

/// A leaf event row returned by queries
#[derive(Debug, Clone, serde::Serialize)]
pub struct LeafRow {
    pub leaf_index: i64,
    pub commitment: String, // hex
    pub created_at: i64,
    pub tx_signature: String,
    pub slot: i64,
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
                slot INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS nullifier_events (
                nullifier_hash BLOB PRIMARY KEY,
                operation_type INTEGER NOT NULL,
                spent_at INTEGER NOT NULL,
                spent_by TEXT NOT NULL,
                tx_signature TEXT NOT NULL,
                slot INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS indexer_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )
        .map_err(|e| format!("migration error: {}", e))?;
        Ok(())
    }

    /// Insert a leaf event. Returns true if inserted, false if duplicate.
    pub fn insert_leaf(
        &self,
        leaf_index: i64,
        event: &LeafInsertedEvent,
        tx_signature: &str,
        slot: i64,
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        let result = conn.execute(
            "INSERT OR IGNORE INTO leaf_events (leaf_index, commitment, created_at, tx_signature, slot)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                leaf_index,
                event.commitment.as_slice(),
                event.created_at,
                tx_signature,
                slot,
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
    ) -> Result<bool, String> {
        let conn = self.conn()?;
        let spent_by_hex = hex::encode(&event.spent_by);
        let result = conn.execute(
            "INSERT OR IGNORE INTO nullifier_events (nullifier_hash, operation_type, spent_at, spent_by, tx_signature, slot)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                event.nullifier_hash.as_slice(),
                event.operation_type as i64,
                event.spent_at,
                spent_by_hex,
                tx_signature,
                slot,
            ],
        );
        match result {
            Ok(n) => Ok(n > 0),
            Err(e) => Err(format!("insert nullifier error: {}", e)),
        }
    }

    /// Get all leaves, optionally filtered by leaf_index > since
    pub fn get_leaves(&self, since: Option<i64>) -> Result<Vec<LeafRow>, String> {
        let conn = self.conn()?;
        let mut stmt = if let Some(since_idx) = since {
            let mut s = conn
                .prepare("SELECT leaf_index, commitment, created_at, tx_signature, slot FROM leaf_events WHERE leaf_index > ?1 ORDER BY leaf_index")
                .map_err(|e| format!("query error: {}", e))?;
            let rows = s
                .query_map(params![since_idx], |row| {
                    let commitment_blob: Vec<u8> = row.get(1)?;
                    Ok(LeafRow {
                        leaf_index: row.get(0)?,
                        commitment: hex::encode(&commitment_blob),
                        created_at: row.get(2)?,
                        tx_signature: row.get(3)?,
                        slot: row.get(4)?,
                    })
                })
                .map_err(|e| format!("query error: {}", e))?;
            return rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e));
        } else {
            conn.prepare("SELECT leaf_index, commitment, created_at, tx_signature, slot FROM leaf_events ORDER BY leaf_index")
                .map_err(|e| format!("query error: {}", e))?
        };

        let rows = stmt
            .query_map([], |row| {
                let commitment_blob: Vec<u8> = row.get(1)?;
                Ok(LeafRow {
                    leaf_index: row.get(0)?,
                    commitment: hex::encode(&commitment_blob),
                    created_at: row.get(2)?,
                    tx_signature: row.get(3)?,
                    slot: row.get(4)?,
                })
            })
            .map_err(|e| format!("query error: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))
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

        assert!(store.insert_leaf(0, &event, "sig1", 100).unwrap());
        assert!(!store.insert_leaf(0, &event, "sig1", 100).unwrap()); // duplicate

        let leaves = store.get_leaves(None).unwrap();
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].leaf_index, 0);
        assert_eq!(leaves[0].created_at, 1700000000);

        assert_eq!(store.get_next_leaf_index().unwrap(), 1);
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

        assert!(store.insert_nullifier(&event, "sig2", 101).unwrap());

        let hash_hex = hex::encode([0xCD; 32]);
        let result = store.get_nullifier(&hash_hex).unwrap();
        assert!(result.is_some());
        let row = result.unwrap();
        assert_eq!(row.operation_type, 2);
        assert_eq!(row.spent_at, 1700000001);
    }
}
