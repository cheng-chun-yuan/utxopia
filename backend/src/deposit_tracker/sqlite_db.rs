//! SQLite Persistent Storage for Deposit Tracker
//!
//! Provides durable storage for deposit records that survives service restarts.
//! Uses connection pooling via r2d2 for concurrent access.

use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension};
use std::path::Path;
use thiserror::Error;

use super::types::{DepositRecord, DepositStatus};

/// SQLite database errors
#[derive(Debug, Error)]
pub enum SqliteError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Pool error: {0}")]
    Pool(#[from] r2d2::Error),

    #[error("Record not found: {0}")]
    NotFound(String),

    #[error("Duplicate record: {0}")]
    Duplicate(String),

    #[error("Migration error: {0}")]
    Migration(String),
}

/// SQLite-backed deposit store with connection pooling
pub struct SqliteDepositStore {
    pool: Pool<SqliteConnectionManager>,
}

impl SqliteDepositStore {
    /// Create a new store with the given database path
    ///
    /// Creates the database file and runs migrations if needed.
    pub fn new<P: AsRef<Path>>(db_path: P) -> Result<Self, SqliteError> {
        // Ensure parent directory exists
        if let Some(parent) = db_path.as_ref().parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let manager = SqliteConnectionManager::file(db_path);
        let pool = Pool::builder()
            .max_size(10)
            .build(manager)?;

        let store = Self { pool };
        store.run_migrations()?;

        Ok(store)
    }

    /// Create an in-memory store (for testing)
    pub fn in_memory() -> Result<Self, SqliteError> {
        let manager = SqliteConnectionManager::memory();
        let pool = Pool::builder()
            .max_size(1)
            .build(manager)?;

        let store = Self { pool };
        store.run_migrations()?;

        Ok(store)
    }

    /// Get a connection from the pool
    fn conn(&self) -> Result<PooledConnection<SqliteConnectionManager>, SqliteError> {
        Ok(self.pool.get()?)
    }

    /// Run database migrations
    fn run_migrations(&self) -> Result<(), SqliteError> {
        let conn = self.conn()?;

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS deposits (
                id TEXT PRIMARY KEY,
                taproot_address TEXT NOT NULL UNIQUE,
                commitment TEXT NOT NULL,
                amount_sats INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                confirmations INTEGER DEFAULT 0,
                deposit_txid TEXT,
                deposit_vout INTEGER,
                deposit_block_height INTEGER,
                sweep_txid TEXT,
                sweep_confirmations INTEGER DEFAULT 0,
                sweep_block_height INTEGER,
                pool_address TEXT,
                solana_tx TEXT,
                leaf_index INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                error TEXT,
                retry_count INTEGER DEFAULT 0,
                last_retry_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
            CREATE INDEX IF NOT EXISTS idx_deposits_taproot_address ON deposits(taproot_address);
            CREATE INDEX IF NOT EXISTS idx_deposits_created_at ON deposits(created_at);
            "#,
        )?;

        Ok(())
    }

    /// Insert a new deposit record
    pub fn insert(&self, record: &DepositRecord) -> Result<(), SqliteError> {
        let conn = self.conn()?;

        conn.execute(
            r#"
            INSERT INTO deposits (
                id, taproot_address, commitment, amount_sats, status,
                confirmations, deposit_txid, deposit_vout, deposit_block_height,
                sweep_txid, sweep_confirmations, sweep_block_height, pool_address,
                solana_tx, leaf_index, created_at, updated_at, error,
                retry_count, last_retry_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8, ?9,
                ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18,
                ?19, ?20
            )
            "#,
            params![
                record.id,
                record.taproot_address,
                record.commitment,
                record.amount_sats as i64,
                record.status.to_string(),
                record.confirmations as i64,
                record.deposit_txid,
                record.deposit_vout.map(|v| v as i64),
                record.deposit_block_height.map(|v| v as i64),
                record.sweep_txid,
                record.sweep_confirmations as i64,
                record.sweep_block_height.map(|v| v as i64),
                record.pool_address,
                record.solana_tx,
                record.leaf_index.map(|v| v as i64),
                record.created_at as i64,
                record.updated_at as i64,
                record.error,
                record.retry_count as i64,
                record.last_retry_at.map(|v| v as i64),
            ],
        ).map_err(|e| {
            if let rusqlite::Error::SqliteFailure(ref err, _) = e {
                if err.extended_code == 1555 || err.extended_code == 2067 {
                    return SqliteError::Duplicate(record.taproot_address.clone());
                }
            }
            SqliteError::Database(e)
        })?;

        Ok(())
    }

    /// Update an existing deposit record
    pub fn update(&self, record: &DepositRecord) -> Result<(), SqliteError> {
        let conn = self.conn()?;

        let rows_affected = conn.execute(
            r#"
            UPDATE deposits SET
                taproot_address = ?2,
                commitment = ?3,
                amount_sats = ?4,
                status = ?5,
                confirmations = ?6,
                deposit_txid = ?7,
                deposit_vout = ?8,
                deposit_block_height = ?9,
                sweep_txid = ?10,
                sweep_confirmations = ?11,
                sweep_block_height = ?12,
                pool_address = ?13,
                solana_tx = ?14,
                leaf_index = ?15,
                updated_at = ?16,
                error = ?17,
                retry_count = ?18,
                last_retry_at = ?19
            WHERE id = ?1
            "#,
            params![
                record.id,
                record.taproot_address,
                record.commitment,
                record.amount_sats as i64,
                record.status.to_string(),
                record.confirmations as i64,
                record.deposit_txid,
                record.deposit_vout.map(|v| v as i64),
                record.deposit_block_height.map(|v| v as i64),
                record.sweep_txid,
                record.sweep_confirmations as i64,
                record.sweep_block_height.map(|v| v as i64),
                record.pool_address,
                record.solana_tx,
                record.leaf_index.map(|v| v as i64),
                record.updated_at as i64,
                record.error,
                record.retry_count as i64,
                record.last_retry_at.map(|v| v as i64),
            ],
        )?;

        if rows_affected == 0 {
            return Err(SqliteError::NotFound(record.id.clone()));
        }

        Ok(())
    }

    /// Get a deposit by ID
    pub fn get_by_id(&self, id: &str) -> Result<Option<DepositRecord>, SqliteError> {
        let conn = self.conn()?;

        let record = conn.query_row(
            "SELECT * FROM deposits WHERE id = ?1",
            params![id],
            |row| Self::row_to_record(row),
        ).optional()?;

        Ok(record)
    }

    /// Get a deposit by taproot address
    pub fn get_by_address(&self, address: &str) -> Result<Option<DepositRecord>, SqliteError> {
        let conn = self.conn()?;

        let record = conn.query_row(
            "SELECT * FROM deposits WHERE taproot_address = ?1",
            params![address],
            |row| Self::row_to_record(row),
        ).optional()?;

        Ok(record)
    }

    /// Get all deposits with a specific status
    pub fn get_by_status(&self, status: DepositStatus) -> Result<Vec<DepositRecord>, SqliteError> {
        let conn = self.conn()?;

        let mut stmt = conn.prepare(
            "SELECT * FROM deposits WHERE status = ?1 ORDER BY created_at ASC"
        )?;

        let records = stmt.query_map(params![status.to_string()], |row| {
            Self::row_to_record(row)
        })?
        .collect::<Result<Vec<_>, _>>()?;

        Ok(records)
    }

    /// Get all deposits that need processing (not in terminal states)
    pub fn get_active(&self) -> Result<Vec<DepositRecord>, SqliteError> {
        let conn = self.conn()?;

        let mut stmt = conn.prepare(
            r#"
            SELECT * FROM deposits
            WHERE status NOT IN ('claimed', 'failed', 'ready')
            ORDER BY created_at ASC
            "#
        )?;

        let records = stmt.query_map([], |row| Self::row_to_record(row))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(records)
    }

    /// Get failed deposits eligible for retry
    pub fn get_failed_for_retry(&self, max_retries: u32) -> Result<Vec<DepositRecord>, SqliteError> {
        let conn = self.conn()?;

        let mut stmt = conn.prepare(
            r#"
            SELECT * FROM deposits
            WHERE status = 'failed' AND retry_count < ?1
            ORDER BY last_retry_at ASC NULLS FIRST, created_at ASC
            "#
        )?;

        let records = stmt.query_map(params![max_retries as i64], |row| {
            Self::row_to_record(row)
        })?
        .collect::<Result<Vec<_>, _>>()?;

        Ok(records)
    }

    /// Get all deposits
    pub fn get_all(&self) -> Result<Vec<DepositRecord>, SqliteError> {
        let conn = self.conn()?;

        let mut stmt = conn.prepare("SELECT * FROM deposits ORDER BY created_at DESC")?;

        let records = stmt.query_map([], |row| Self::row_to_record(row))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(records)
    }

    /// Get deposit count by status
    pub fn count_by_status(&self) -> Result<std::collections::HashMap<String, u64>, SqliteError> {
        let conn = self.conn()?;

        let mut stmt = conn.prepare(
            "SELECT status, COUNT(*) as count FROM deposits GROUP BY status"
        )?;

        let mut counts = std::collections::HashMap::new();
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;

        for row in rows {
            let (status, count) = row?;
            counts.insert(status, count as u64);
        }

        Ok(counts)
    }

    /// Get total satoshis received (for ready/claimed deposits)
    pub fn total_sats_received(&self) -> Result<u64, SqliteError> {
        let conn = self.conn()?;

        let total: i64 = conn.query_row(
            "SELECT COALESCE(SUM(amount_sats), 0) FROM deposits WHERE status IN ('ready', 'claimed')",
            [],
            |row| row.get(0),
        )?;

        Ok(total as u64)
    }

    /// Delete a deposit by ID
    pub fn delete(&self, id: &str) -> Result<bool, SqliteError> {
        let conn = self.conn()?;

        let rows_affected = conn.execute(
            "DELETE FROM deposits WHERE id = ?1",
            params![id],
        )?;

        Ok(rows_affected > 0)
    }

    /// Convert a database row to DepositRecord
    fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<DepositRecord> {
        let status_str: String = row.get("status")?;
        let status = status_str.parse().unwrap_or(DepositStatus::Pending);

        Ok(DepositRecord {
            id: row.get("id")?,
            taproot_address: row.get("taproot_address")?,
            commitment: row.get("commitment")?,
            amount_sats: row.get::<_, i64>("amount_sats")? as u64,
            status,
            confirmations: row.get::<_, i64>("confirmations")? as u32,
            deposit_txid: row.get("deposit_txid")?,
            deposit_vout: row.get::<_, Option<i64>>("deposit_vout")?.map(|v| v as u32),
            deposit_block_height: row.get::<_, Option<i64>>("deposit_block_height")?.map(|v| v as u64),
            sweep_txid: row.get("sweep_txid")?,
            sweep_confirmations: row.get::<_, i64>("sweep_confirmations")? as u32,
            sweep_block_height: row.get::<_, Option<i64>>("sweep_block_height")?.map(|v| v as u64),
            pool_address: row.get("pool_address")?,
            solana_tx: row.get("solana_tx")?,
            leaf_index: row.get::<_, Option<i64>>("leaf_index")?.map(|v| v as u64),
            created_at: row.get::<_, i64>("created_at")? as u64,
            updated_at: row.get::<_, i64>("updated_at")? as u64,
            error: row.get("error")?,
            retry_count: row.get::<_, i64>("retry_count")? as u32,
            last_retry_at: row.get::<_, Option<i64>>("last_retry_at")?.map(|v| v as u64),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_record(id: &str, address: &str) -> DepositRecord {
        let mut record = DepositRecord::new(
            address.to_string(),
            "a".repeat(64),
            100_000,
        );
        record.id = id.to_string();
        record
    }

    #[test]
    fn test_insert_and_get() {
        let store = SqliteDepositStore::in_memory().unwrap();
        let record = create_test_record("test1", "tb1p_test1");

        store.insert(&record).unwrap();

        let retrieved = store.get_by_id("test1").unwrap().unwrap();
        assert_eq!(retrieved.id, "test1");
        assert_eq!(retrieved.taproot_address, "tb1p_test1");
    }

    #[test]
    fn test_get_by_address() {
        let store = SqliteDepositStore::in_memory().unwrap();
        let record = create_test_record("test1", "tb1p_unique_addr");

        store.insert(&record).unwrap();

        let retrieved = store.get_by_address("tb1p_unique_addr").unwrap().unwrap();
        assert_eq!(retrieved.id, "test1");
    }

    #[test]
    fn test_duplicate_address() {
        let store = SqliteDepositStore::in_memory().unwrap();

        let record1 = create_test_record("test1", "tb1p_same");
        let record2 = create_test_record("test2", "tb1p_same");

        store.insert(&record1).unwrap();
        let result = store.insert(&record2);

        assert!(matches!(result, Err(SqliteError::Duplicate(_))));
    }

    #[test]
    fn test_update() {
        let store = SqliteDepositStore::in_memory().unwrap();
        let mut record = create_test_record("test1", "tb1p_update");

        store.insert(&record).unwrap();

        record.mark_detected("txid123".to_string(), 0);
        store.update(&record).unwrap();

        let retrieved = store.get_by_id("test1").unwrap().unwrap();
        assert_eq!(retrieved.status, DepositStatus::Detected);
        assert_eq!(retrieved.deposit_txid, Some("txid123".to_string()));
    }

    #[test]
    fn test_get_by_status() {
        let store = SqliteDepositStore::in_memory().unwrap();

        let record1 = create_test_record("test1", "tb1p_1");
        let mut record2 = create_test_record("test2", "tb1p_2");
        record2.status = DepositStatus::Confirmed;

        store.insert(&record1).unwrap();
        store.insert(&record2).unwrap();

        let pending = store.get_by_status(DepositStatus::Pending).unwrap();
        assert_eq!(pending.len(), 1);

        let confirmed = store.get_by_status(DepositStatus::Confirmed).unwrap();
        assert_eq!(confirmed.len(), 1);
    }

    #[test]
    fn test_get_active() {
        let store = SqliteDepositStore::in_memory().unwrap();

        let record1 = create_test_record("test1", "tb1p_1");
        let mut record2 = create_test_record("test2", "tb1p_2");
        record2.status = DepositStatus::Ready;
        let mut record3 = create_test_record("test3", "tb1p_3");
        record3.status = DepositStatus::Confirmed;

        store.insert(&record1).unwrap();
        store.insert(&record2).unwrap();
        store.insert(&record3).unwrap();

        let active = store.get_active().unwrap();
        assert_eq!(active.len(), 2); // pending and confirmed, not ready
    }

    #[test]
    fn test_get_failed_for_retry() {
        let store = SqliteDepositStore::in_memory().unwrap();

        let mut record1 = create_test_record("test1", "tb1p_1");
        record1.status = DepositStatus::Failed;
        record1.retry_count = 0;

        let mut record2 = create_test_record("test2", "tb1p_2");
        record2.status = DepositStatus::Failed;
        record2.retry_count = 5;

        store.insert(&record1).unwrap();
        store.insert(&record2).unwrap();

        let retryable = store.get_failed_for_retry(5).unwrap();
        assert_eq!(retryable.len(), 1);
        assert_eq!(retryable[0].id, "test1");
    }

    #[test]
    fn test_count_by_status() {
        let store = SqliteDepositStore::in_memory().unwrap();

        store.insert(&create_test_record("test1", "tb1p_1")).unwrap();
        store.insert(&create_test_record("test2", "tb1p_2")).unwrap();

        let mut record3 = create_test_record("test3", "tb1p_3");
        record3.status = DepositStatus::Ready;
        store.insert(&record3).unwrap();

        let counts = store.count_by_status().unwrap();
        assert_eq!(counts.get("pending"), Some(&2));
        assert_eq!(counts.get("ready"), Some(&1));
    }
}
