//! SQLite Persistent Storage for Deposit Tracker
//!
//! Provides durable storage for deposit records that survives service restarts.
//! Uses connection pooling via r2d2 for concurrent access.

use async_trait::async_trait;
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension};
use std::path::Path;

use super::traits::{DepositStore, StorageError, StorageResult};
use crate::types::deposit::{DepositRecord, DepositStatus};

/// SQLite-backed deposit store with connection pooling
pub struct SqliteDepositStore {
    pool: Pool<SqliteConnectionManager>,
}

impl SqliteDepositStore {
    /// Create a new store with the given database path
    ///
    /// Creates the database file and runs migrations if needed.
    pub fn new<P: AsRef<Path>>(db_path: P) -> Result<Self, StorageError> {
        // Ensure parent directory exists
        if let Some(parent) = db_path.as_ref().parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let manager = SqliteConnectionManager::file(db_path);
        let pool = Pool::builder()
            .max_size(10)
            .build(manager)
            .map_err(|e| StorageError::Connection(e.to_string()))?;

        let store = Self { pool };
        store.run_migrations()?;

        Ok(store)
    }

    /// Create an in-memory store (for testing)
    pub fn in_memory() -> Result<Self, StorageError> {
        let manager = SqliteConnectionManager::memory();
        let pool = Pool::builder()
            .max_size(1)
            .build(manager)
            .map_err(|e| StorageError::Connection(e.to_string()))?;

        let store = Self { pool };
        store.run_migrations()?;

        Ok(store)
    }

    /// Get a connection from the pool
    fn conn(&self) -> Result<PooledConnection<SqliteConnectionManager>, StorageError> {
        self.pool
            .get()
            .map_err(|e| StorageError::Connection(e.to_string()))
    }

    /// Run database migrations
    fn run_migrations(&self) -> Result<(), StorageError> {
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
        )
        .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(())
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
            deposit_block_height: row
                .get::<_, Option<i64>>("deposit_block_height")?
                .map(|v| v as u64),
            sweep_txid: row.get("sweep_txid")?,
            sweep_confirmations: row.get::<_, i64>("sweep_confirmations")? as u32,
            sweep_block_height: row
                .get::<_, Option<i64>>("sweep_block_height")?
                .map(|v| v as u64),
            pool_address: row.get("pool_address")?,
            solana_tx: row.get("solana_tx")?,
            leaf_index: row.get::<_, Option<i64>>("leaf_index")?.map(|v| v as u64),
            created_at: row.get::<_, i64>("created_at")? as u64,
            updated_at: row.get::<_, i64>("updated_at")? as u64,
            error: row.get("error")?,
            retry_count: row.get::<_, i64>("retry_count")? as u32,
            last_retry_at: row
                .get::<_, Option<i64>>("last_retry_at")?
                .map(|v| v as u64),
        })
    }

    // Synchronous helper methods for the trait implementations

    fn insert_sync(&self, record: &DepositRecord) -> Result<(), StorageError> {
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
        )
        .map_err(|e| {
            if let rusqlite::Error::SqliteFailure(ref err, _) = e {
                if err.extended_code == 1555 || err.extended_code == 2067 {
                    return StorageError::Duplicate(record.taproot_address.clone());
                }
            }
            StorageError::Database(e.to_string())
        })?;

        Ok(())
    }

    fn update_sync(&self, record: &DepositRecord) -> Result<(), StorageError> {
        let conn = self.conn()?;

        let rows_affected = conn
            .execute(
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
            )
            .map_err(|e| StorageError::Database(e.to_string()))?;

        if rows_affected == 0 {
            return Err(StorageError::NotFound(record.id.clone()));
        }

        Ok(())
    }

    fn get_by_id_sync(&self, id: &str) -> Result<Option<DepositRecord>, StorageError> {
        let conn = self.conn()?;

        let record = conn
            .query_row(
                "SELECT * FROM deposits WHERE id = ?1",
                params![id],
                |row| Self::row_to_record(row),
            )
            .optional()
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(record)
    }

    fn get_by_address_sync(&self, address: &str) -> Result<Option<DepositRecord>, StorageError> {
        let conn = self.conn()?;

        let record = conn
            .query_row(
                "SELECT * FROM deposits WHERE taproot_address = ?1",
                params![address],
                |row| Self::row_to_record(row),
            )
            .optional()
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(record)
    }

    fn get_by_status_sync(&self, status: DepositStatus) -> Result<Vec<DepositRecord>, StorageError> {
        let conn = self.conn()?;

        let mut stmt = conn
            .prepare("SELECT * FROM deposits WHERE status = ?1 ORDER BY created_at ASC")
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let records = stmt
            .query_map(params![status.to_string()], |row| Self::row_to_record(row))
            .map_err(|e| StorageError::Database(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(records)
    }

    fn get_active_sync(&self) -> Result<Vec<DepositRecord>, StorageError> {
        let conn = self.conn()?;

        let mut stmt = conn
            .prepare(
                r#"
            SELECT * FROM deposits
            WHERE status NOT IN ('claimed', 'failed', 'ready')
            ORDER BY created_at ASC
            "#,
            )
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let records = stmt
            .query_map([], |row| Self::row_to_record(row))
            .map_err(|e| StorageError::Database(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(records)
    }

    fn get_all_sync(&self) -> Result<Vec<DepositRecord>, StorageError> {
        let conn = self.conn()?;

        let mut stmt = conn
            .prepare("SELECT * FROM deposits ORDER BY created_at DESC")
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let records = stmt
            .query_map([], |row| Self::row_to_record(row))
            .map_err(|e| StorageError::Database(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(records)
    }

    fn get_failed_for_retry_sync(&self, max_retries: u32) -> Result<Vec<DepositRecord>, StorageError> {
        let conn = self.conn()?;

        let mut stmt = conn
            .prepare(
                r#"
            SELECT * FROM deposits
            WHERE status = 'failed' AND retry_count < ?1
            ORDER BY last_retry_at ASC NULLS FIRST, created_at ASC
            "#,
            )
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let records = stmt
            .query_map(params![max_retries as i64], |row| Self::row_to_record(row))
            .map_err(|e| StorageError::Database(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(records)
    }

    fn delete_sync(&self, id: &str) -> Result<bool, StorageError> {
        let conn = self.conn()?;

        let rows_affected = conn
            .execute("DELETE FROM deposits WHERE id = ?1", params![id])
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(rows_affected > 0)
    }

    fn count_by_status_sync(&self) -> Result<std::collections::HashMap<String, u64>, StorageError> {
        let conn = self.conn()?;

        let mut stmt = conn
            .prepare("SELECT status, COUNT(*) as count FROM deposits GROUP BY status")
            .map_err(|e| StorageError::Database(e.to_string()))?;

        let mut counts = std::collections::HashMap::new();
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
            .map_err(|e| StorageError::Database(e.to_string()))?;

        for row in rows {
            let (status, count) = row.map_err(|e| StorageError::Database(e.to_string()))?;
            counts.insert(status, count as u64);
        }

        Ok(counts)
    }

    fn total_sats_received_sync(&self) -> Result<u64, StorageError> {
        let conn = self.conn()?;

        let total: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(amount_sats), 0) FROM deposits WHERE status IN ('ready', 'claimed')",
                [],
                |row| row.get(0),
            )
            .map_err(|e| StorageError::Database(e.to_string()))?;

        Ok(total as u64)
    }
}

#[async_trait]
impl DepositStore for SqliteDepositStore {
    async fn insert(&self, record: &DepositRecord) -> StorageResult<()> {
        self.insert_sync(record)
    }

    async fn update(&self, record: &DepositRecord) -> StorageResult<()> {
        self.update_sync(record)
    }

    async fn get_by_id(&self, id: &str) -> StorageResult<Option<DepositRecord>> {
        self.get_by_id_sync(id)
    }

    async fn get_by_address(&self, address: &str) -> StorageResult<Option<DepositRecord>> {
        self.get_by_address_sync(address)
    }

    async fn get_by_status(&self, status: DepositStatus) -> StorageResult<Vec<DepositRecord>> {
        self.get_by_status_sync(status)
    }

    async fn get_active(&self) -> StorageResult<Vec<DepositRecord>> {
        self.get_active_sync()
    }

    async fn get_all(&self) -> StorageResult<Vec<DepositRecord>> {
        self.get_all_sync()
    }

    async fn get_failed_for_retry(&self, max_retries: u32) -> StorageResult<Vec<DepositRecord>> {
        self.get_failed_for_retry_sync(max_retries)
    }

    async fn delete(&self, id: &str) -> StorageResult<bool> {
        self.delete_sync(id)
    }

    async fn count_by_status(&self) -> StorageResult<std::collections::HashMap<String, u64>> {
        self.count_by_status_sync()
    }

    async fn total_sats_received(&self) -> StorageResult<u64> {
        self.total_sats_received_sync()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_record(id: &str, address: &str) -> DepositRecord {
        let mut record = DepositRecord::new(address.to_string(), "a".repeat(64), 100_000);
        record.id = id.to_string();
        record
    }

    #[tokio::test]
    async fn test_insert_and_get() {
        let store = SqliteDepositStore::in_memory().unwrap();
        let record = create_test_record("test1", "tb1p_test1");

        store.insert(&record).await.unwrap();

        let retrieved = store.get_by_id("test1").await.unwrap().unwrap();
        assert_eq!(retrieved.id, "test1");
        assert_eq!(retrieved.taproot_address, "tb1p_test1");
    }

    #[tokio::test]
    async fn test_get_by_address() {
        let store = SqliteDepositStore::in_memory().unwrap();
        let record = create_test_record("test1", "tb1p_unique_addr");

        store.insert(&record).await.unwrap();

        let retrieved = store
            .get_by_address("tb1p_unique_addr")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retrieved.id, "test1");
    }

    #[tokio::test]
    async fn test_duplicate_address() {
        let store = SqliteDepositStore::in_memory().unwrap();

        let record1 = create_test_record("test1", "tb1p_same");
        let record2 = create_test_record("test2", "tb1p_same");

        store.insert(&record1).await.unwrap();
        let result = store.insert(&record2).await;

        assert!(matches!(result, Err(StorageError::Duplicate(_))));
    }

    #[tokio::test]
    async fn test_update() {
        let store = SqliteDepositStore::in_memory().unwrap();
        let mut record = create_test_record("test1", "tb1p_update");

        store.insert(&record).await.unwrap();

        record.mark_detected("txid123".to_string(), 0);
        store.update(&record).await.unwrap();

        let retrieved = store.get_by_id("test1").await.unwrap().unwrap();
        assert_eq!(retrieved.status, DepositStatus::Detected);
        assert_eq!(retrieved.deposit_txid, Some("txid123".to_string()));
    }

    #[tokio::test]
    async fn test_get_by_status() {
        let store = SqliteDepositStore::in_memory().unwrap();

        let record1 = create_test_record("test1", "tb1p_1");
        let mut record2 = create_test_record("test2", "tb1p_2");
        record2.status = DepositStatus::Confirmed;

        store.insert(&record1).await.unwrap();
        store.insert(&record2).await.unwrap();

        let pending = store.get_by_status(DepositStatus::Pending).await.unwrap();
        assert_eq!(pending.len(), 1);

        let confirmed = store.get_by_status(DepositStatus::Confirmed).await.unwrap();
        assert_eq!(confirmed.len(), 1);
    }

    #[tokio::test]
    async fn test_get_active() {
        let store = SqliteDepositStore::in_memory().unwrap();

        let record1 = create_test_record("test1", "tb1p_1");
        let mut record2 = create_test_record("test2", "tb1p_2");
        record2.status = DepositStatus::Ready;
        let mut record3 = create_test_record("test3", "tb1p_3");
        record3.status = DepositStatus::Confirmed;

        store.insert(&record1).await.unwrap();
        store.insert(&record2).await.unwrap();
        store.insert(&record3).await.unwrap();

        let active = store.get_active().await.unwrap();
        assert_eq!(active.len(), 2); // pending and confirmed, not ready
    }
}
