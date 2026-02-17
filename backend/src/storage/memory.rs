//! In-Memory Storage Implementations
//!
//! Provides in-memory storage for testing and development.
//! Data is lost when the service restarts.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::traits::{StealthDepositStats, StealthStore, StorageError, StorageResult};
use crate::types::stealth::{StealthDepositRecord, StealthDepositStatus};

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
                StealthDepositStatus::Ready
                | StealthDepositStatus::Announcing
                | StealthDepositStatus::Announced => stats.ready += 1,
                StealthDepositStatus::Expired | StealthDepositStatus::Failed => stats.failed += 1,
            }

            if let Some(amount) = record.actual_amount_sats {
                stats.total_sats += amount;
            }
        }

        stats
    }
}

impl Default for StealthDepositStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl StealthStore for StealthDepositStore {
    async fn insert(&self, record: StealthDepositRecord) -> StorageResult<()> {
        let mut records = self.records.write().await;
        let mut by_address = self.by_address.write().await;

        // Check for duplicate ID
        if records.contains_key(&record.id) {
            return Err(StorageError::Duplicate(format!("ID: {}", record.id)));
        }

        // Check for duplicate BTC address
        if by_address.contains_key(&record.btc_address) {
            return Err(StorageError::Duplicate(format!(
                "BTC address: {}",
                record.btc_address
            )));
        }

        // Insert into both indexes
        by_address.insert(record.btc_address.clone(), record.id.clone());
        records.insert(record.id.clone(), record);

        Ok(())
    }

    async fn get(&self, id: &str) -> StorageResult<Option<StealthDepositRecord>> {
        let records = self.records.read().await;
        Ok(records.get(id).cloned())
    }

    async fn get_by_address(&self, btc_address: &str) -> StorageResult<Option<StealthDepositRecord>> {
        let by_address = self.by_address.read().await;
        let id = match by_address.get(btc_address) {
            Some(id) => id.clone(),
            None => return Ok(None),
        };
        drop(by_address);

        let records = self.records.read().await;
        Ok(records.get(&id).cloned())
    }

    async fn update(&self, record: StealthDepositRecord) -> StorageResult<()> {
        let mut records = self.records.write().await;

        if !records.contains_key(&record.id) {
            return Err(StorageError::NotFound(record.id));
        }

        records.insert(record.id.clone(), record);
        Ok(())
    }

    async fn get_by_status(
        &self,
        status: StealthDepositStatus,
    ) -> StorageResult<Vec<StealthDepositRecord>> {
        let records = self.records.read().await;
        Ok(records
            .values()
            .filter(|r| r.status == status)
            .cloned()
            .collect())
    }

    async fn get_active(&self) -> StorageResult<Vec<StealthDepositRecord>> {
        let records = self.records.read().await;
        Ok(records
            .values()
            .filter(|r| {
                !matches!(
                    r.status,
                    StealthDepositStatus::Ready | StealthDepositStatus::Failed
                )
            })
            .cloned()
            .collect())
    }

    async fn get_pending(&self) -> StorageResult<Vec<StealthDepositRecord>> {
        self.get_by_status(StealthDepositStatus::Pending).await
    }

    async fn get_ready_to_sweep(&self) -> StorageResult<Vec<StealthDepositRecord>> {
        let records = self.records.read().await;
        Ok(records.values().filter(|r| r.can_sweep()).cloned().collect())
    }

    async fn get_ready_to_verify(&self) -> StorageResult<Vec<StealthDepositRecord>> {
        let records = self.records.read().await;
        Ok(records
            .values()
            .filter(|r| r.can_verify())
            .cloned()
            .collect())
    }

    async fn get_all(&self) -> StorageResult<Vec<StealthDepositRecord>> {
        let records = self.records.read().await;
        Ok(records.values().cloned().collect())
    }

    async fn count(&self) -> StorageResult<usize> {
        let records = self.records.read().await;
        Ok(records.len())
    }

    async fn cleanup_expired(&self) -> StorageResult<u64> {
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

        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_record(id: &str, address: &str) -> StealthDepositRecord {
        let mut record = StealthDepositRecord::new(
            "viewing_pub".to_string(),
            "spending_pub".to_string(),
            "ephemeral_pub".to_string(),
            "ephemeral_priv_encrypted".to_string(),
            "commitment".to_string(),
            address.to_string(),
        );
        record.id = id.to_string();
        record
    }

    #[tokio::test]
    async fn test_insert_and_get() {
        let store = StealthDepositStore::new();
        let record = create_test_record("test1", "tb1p_test1");

        store.insert(record.clone()).await.unwrap();

        let retrieved = store.get("test1").await.unwrap().unwrap();
        assert_eq!(retrieved.id, "test1");
        assert_eq!(retrieved.btc_address, "tb1p_test1");
    }

    #[tokio::test]
    async fn test_get_by_address() {
        let store = StealthDepositStore::new();
        let record = create_test_record("test1", "tb1p_test_addr");

        store.insert(record).await.unwrap();

        let retrieved = store.get_by_address("tb1p_test_addr").await.unwrap().unwrap();
        assert_eq!(retrieved.id, "test1");
    }

    #[tokio::test]
    async fn test_duplicate_id_error() {
        let store = StealthDepositStore::new();
        let record1 = create_test_record("test1", "tb1p_addr1");
        let record2 = create_test_record("test1", "tb1p_addr2");

        store.insert(record1).await.unwrap();
        let result = store.insert(record2).await;

        assert!(matches!(result, Err(StorageError::Duplicate(_))));
    }

    #[tokio::test]
    async fn test_duplicate_address_error() {
        let store = StealthDepositStore::new();
        let record1 = create_test_record("test1", "tb1p_same_addr");
        let record2 = create_test_record("test2", "tb1p_same_addr");

        store.insert(record1).await.unwrap();
        let result = store.insert(record2).await;

        assert!(matches!(result, Err(StorageError::Duplicate(_))));
    }

    #[tokio::test]
    async fn test_update() {
        let store = StealthDepositStore::new();
        let mut record = create_test_record("test1", "tb1p_addr");

        store.insert(record.clone()).await.unwrap();

        record.mark_detected("txid".to_string(), 0, 100000);
        store.update(record).await.unwrap();

        let retrieved = store.get("test1").await.unwrap().unwrap();
        assert_eq!(retrieved.status, StealthDepositStatus::Detected);
        assert_eq!(retrieved.actual_amount_sats, Some(100000));
    }

    #[tokio::test]
    async fn test_get_by_status() {
        let store = StealthDepositStore::new();

        let record1 = create_test_record("test1", "tb1p_addr1");

        let mut record2 = create_test_record("test2", "tb1p_addr2");
        record2.status = StealthDepositStatus::Ready;

        store.insert(record1).await.unwrap();
        store.insert(record2).await.unwrap();

        let pending = store.get_by_status(StealthDepositStatus::Pending).await.unwrap();
        assert_eq!(pending.len(), 1);

        let ready = store.get_by_status(StealthDepositStatus::Ready).await.unwrap();
        assert_eq!(ready.len(), 1);
    }
}
