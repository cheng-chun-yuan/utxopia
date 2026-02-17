//! Stealth Deposit V2 Database
//!
//! In-memory storage for stealth deposits. Can be swapped for SQLite/PostgreSQL
//! in production by implementing the same interface.
//!
//! Schema (for future SQLite migration):
//! ```sql
//! CREATE TABLE stealth_deposits_v2 (
//!     id TEXT PRIMARY KEY,
//!     viewing_pub BLOB NOT NULL,
//!     spending_pub BLOB NOT NULL,
//!     ephemeral_priv BLOB NOT NULL,
//!     ephemeral_pub BLOB NOT NULL,
//!     commitment BLOB NOT NULL,
//!     btc_address TEXT NOT NULL UNIQUE,
//!     actual_amount_sats INTEGER,
//!     status TEXT NOT NULL DEFAULT 'pending',
//!     confirmations INTEGER DEFAULT 0,
//!     deposit_txid TEXT,
//!     deposit_vout INTEGER,
//!     deposit_block_height INTEGER,
//!     sweep_txid TEXT,
//!     sweep_confirmations INTEGER DEFAULT 0,
//!     sweep_block_height INTEGER,
//!     solana_tx TEXT,
//!     leaf_index INTEGER,
//!     error TEXT,
//!     created_at INTEGER NOT NULL,
//!     updated_at INTEGER NOT NULL,
//!     expires_at INTEGER NOT NULL
//! );
//! ```

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::types::{StealthDepositRecord, StealthDepositStatus};

/// Error type for database operations
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("Record not found: {0}")]
    NotFound(String),

    #[error("Duplicate key: {0}")]
    DuplicateKey(String),

    #[error("Invalid data: {0}")]
    InvalidData(String),
}

/// In-memory stealth deposit store
///
/// Thread-safe storage for stealth deposit records.
/// Uses Arc<RwLock<>> for concurrent access.
#[derive(Clone)]
pub struct StealthDepositStore {
    /// Records indexed by deposit ID
    records: Arc<RwLock<HashMap<String, StealthDepositRecord>>>,
    /// Index: BTC address -> deposit ID
    by_address: Arc<RwLock<HashMap<String, String>>>,
}

impl StealthDepositStore {
    /// Create a new empty store
    pub fn new() -> Self {
        Self {
            records: Arc::new(RwLock::new(HashMap::new())),
            by_address: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Insert a new stealth deposit record
    ///
    /// Returns error if ID or BTC address already exists.
    pub async fn insert(&self, record: StealthDepositRecord) -> Result<(), DbError> {
        let mut records = self.records.write().await;
        let mut by_address = self.by_address.write().await;

        // Check for duplicate ID
        if records.contains_key(&record.id) {
            return Err(DbError::DuplicateKey(format!("ID: {}", record.id)));
        }

        // Check for duplicate BTC address
        if by_address.contains_key(&record.btc_address) {
            return Err(DbError::DuplicateKey(format!(
                "BTC address: {}",
                record.btc_address
            )));
        }

        // Insert into both indexes
        by_address.insert(record.btc_address.clone(), record.id.clone());
        records.insert(record.id.clone(), record);

        Ok(())
    }

    /// Get a record by ID
    pub async fn get(&self, id: &str) -> Option<StealthDepositRecord> {
        let records = self.records.read().await;
        records.get(id).cloned()
    }

    /// Get a record by BTC address
    pub async fn get_by_address(&self, btc_address: &str) -> Option<StealthDepositRecord> {
        let by_address = self.by_address.read().await;
        let id = by_address.get(btc_address)?;

        let records = self.records.read().await;
        records.get(id).cloned()
    }

    /// Update a record
    ///
    /// Returns error if record doesn't exist.
    pub async fn update(&self, record: StealthDepositRecord) -> Result<(), DbError> {
        let mut records = self.records.write().await;

        if !records.contains_key(&record.id) {
            return Err(DbError::NotFound(record.id));
        }

        records.insert(record.id.clone(), record);
        Ok(())
    }

    /// Get all records with a specific status
    pub async fn get_by_status(&self, status: StealthDepositStatus) -> Vec<StealthDepositRecord> {
        let records = self.records.read().await;
        records
            .values()
            .filter(|r| r.status == status)
            .cloned()
            .collect()
    }

    /// Get all records that need processing (not terminal states)
    pub async fn get_active(&self) -> Vec<StealthDepositRecord> {
        let records = self.records.read().await;
        records
            .values()
            .filter(|r| !matches!(r.status, StealthDepositStatus::Ready | StealthDepositStatus::Failed))
            .cloned()
            .collect()
    }

    /// Get all pending deposits (waiting for BTC)
    pub async fn get_pending(&self) -> Vec<StealthDepositRecord> {
        self.get_by_status(StealthDepositStatus::Pending).await
    }

    /// Get all deposits ready to sweep
    pub async fn get_ready_to_sweep(&self) -> Vec<StealthDepositRecord> {
        let records = self.records.read().await;
        records
            .values()
            .filter(|r| r.can_sweep())
            .cloned()
            .collect()
    }

    /// Get all deposits ready to verify on-chain
    pub async fn get_ready_to_verify(&self) -> Vec<StealthDepositRecord> {
        let records = self.records.read().await;
        records
            .values()
            .filter(|r| r.can_verify())
            .cloned()
            .collect()
    }

    /// Get all records
    pub async fn get_all(&self) -> Vec<StealthDepositRecord> {
        let records = self.records.read().await;
        records.values().cloned().collect()
    }

    /// Get count of records
    pub async fn count(&self) -> usize {
        let records = self.records.read().await;
        records.len()
    }

    /// Get statistics
    pub async fn stats(&self) -> StealthDepositStats {
        let records = self.records.read().await;

        let mut stats = StealthDepositStats::default();
        stats.total = records.len() as u64;

        for record in records.values() {
            match record.status {
                StealthDepositStatus::Pending => stats.pending += 1,
                StealthDepositStatus::Detected
                | StealthDepositStatus::Confirming
                | StealthDepositStatus::Confirmed => stats.confirming += 1,
                StealthDepositStatus::Sweeping | StealthDepositStatus::SweepConfirming => {
                    stats.sweeping += 1
                }
                StealthDepositStatus::Verifying => stats.verifying += 1,
                StealthDepositStatus::Ready => stats.ready += 1,
                StealthDepositStatus::Failed => stats.failed += 1,
            }

            if let Some(amount) = record.actual_amount_sats {
                stats.total_sats += amount;
            }
        }

        stats
    }

    /// Delete expired pending deposits
    pub async fn cleanup_expired(&self) -> u64 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let mut records = self.records.write().await;
        let mut by_address = self.by_address.write().await;

        let expired_ids: Vec<String> = records
            .values()
            .filter(|r| r.status == StealthDepositStatus::Pending && r.expires_at < now)
            .map(|r| r.id.clone())
            .collect();

        let count = expired_ids.len() as u64;

        for id in expired_ids {
            if let Some(record) = records.remove(&id) {
                by_address.remove(&record.btc_address);
            }
        }

        count
    }
}

impl Default for StealthDepositStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Statistics for stealth deposits
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct StealthDepositStats {
    pub total: u64,
    pub pending: u64,
    pub confirming: u64,
    pub sweeping: u64,
    pub verifying: u64,
    pub ready: u64,
    pub failed: u64,
    pub total_sats: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_record(id: &str, address: &str) -> StealthDepositRecord {
        StealthDepositRecord::new(
            "viewing_pub".to_string(),
            "spending_pub".to_string(),
            "ephemeral_pub".to_string(),
            "ephemeral_priv_encrypted".to_string(),
            "commitment".to_string(),
            address.to_string(),
        )
    }

    #[tokio::test]
    async fn test_insert_and_get() {
        let store = StealthDepositStore::new();
        let mut record = create_test_record("test1", "tb1p_test1");
        record.id = "test1".to_string();

        store.insert(record.clone()).await.unwrap();

        let retrieved = store.get("test1").await.unwrap();
        assert_eq!(retrieved.id, "test1");
        assert_eq!(retrieved.btc_address, "tb1p_test1");
    }

    #[tokio::test]
    async fn test_get_by_address() {
        let store = StealthDepositStore::new();
        let mut record = create_test_record("test1", "tb1p_test_addr");
        record.id = "test1".to_string();

        store.insert(record).await.unwrap();

        let retrieved = store.get_by_address("tb1p_test_addr").await.unwrap();
        assert_eq!(retrieved.id, "test1");
    }

    #[tokio::test]
    async fn test_duplicate_id_error() {
        let store = StealthDepositStore::new();
        let mut record1 = create_test_record("test1", "tb1p_addr1");
        record1.id = "test1".to_string();
        let mut record2 = create_test_record("test1", "tb1p_addr2");
        record2.id = "test1".to_string();

        store.insert(record1).await.unwrap();
        let result = store.insert(record2).await;

        assert!(matches!(result, Err(DbError::DuplicateKey(_))));
    }

    #[tokio::test]
    async fn test_duplicate_address_error() {
        let store = StealthDepositStore::new();
        let mut record1 = create_test_record("test1", "tb1p_same_addr");
        record1.id = "test1".to_string();
        let mut record2 = create_test_record("test2", "tb1p_same_addr");
        record2.id = "test2".to_string();

        store.insert(record1).await.unwrap();
        let result = store.insert(record2).await;

        assert!(matches!(result, Err(DbError::DuplicateKey(_))));
    }

    #[tokio::test]
    async fn test_update() {
        let store = StealthDepositStore::new();
        let mut record = create_test_record("test1", "tb1p_addr");
        record.id = "test1".to_string();

        store.insert(record.clone()).await.unwrap();

        record.mark_detected("txid".to_string(), 0, 100000);
        store.update(record).await.unwrap();

        let retrieved = store.get("test1").await.unwrap();
        assert_eq!(retrieved.status, StealthDepositStatus::Detected);
        assert_eq!(retrieved.actual_amount_sats, Some(100000));
    }

    #[tokio::test]
    async fn test_get_by_status() {
        let store = StealthDepositStore::new();

        let mut record1 = create_test_record("test1", "tb1p_addr1");
        record1.id = "test1".to_string();

        let mut record2 = create_test_record("test2", "tb1p_addr2");
        record2.id = "test2".to_string();
        record2.status = StealthDepositStatus::Ready;

        store.insert(record1).await.unwrap();
        store.insert(record2).await.unwrap();

        let pending = store.get_by_status(StealthDepositStatus::Pending).await;
        assert_eq!(pending.len(), 1);

        let ready = store.get_by_status(StealthDepositStatus::Ready).await;
        assert_eq!(ready.len(), 1);
    }
}
