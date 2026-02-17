//! Storage Trait Definitions
//!
//! Defines abstract storage interfaces for deposits and stealth records.
//! Implementations can use SQLite (production) or in-memory (testing).

use async_trait::async_trait;
use thiserror::Error;

use crate::types::deposit::{DepositRecord, DepositStatus};
use crate::types::stealth::{StealthDepositRecord, StealthDepositStatus};

/// Storage errors
#[derive(Debug, Error)]
pub enum StorageError {
    #[error("Record not found: {0}")]
    NotFound(String),

    #[error("Duplicate record: {0}")]
    Duplicate(String),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Invalid data: {0}")]
    InvalidData(String),

    #[error("Connection error: {0}")]
    Connection(String),
}

/// Result type for storage operations
pub type StorageResult<T> = Result<T, StorageError>;

/// Deposit storage interface
///
/// Implementations:
/// - `SqliteDepositStore` - Production storage with SQLite
/// - `MemoryDepositStore` - In-memory storage for testing
#[async_trait]
pub trait DepositStore: Send + Sync {
    /// Insert a new deposit record
    async fn insert(&self, record: &DepositRecord) -> StorageResult<()>;

    /// Update an existing deposit record
    async fn update(&self, record: &DepositRecord) -> StorageResult<()>;

    /// Get a deposit by ID
    async fn get_by_id(&self, id: &str) -> StorageResult<Option<DepositRecord>>;

    /// Get a deposit by taproot address
    async fn get_by_address(&self, address: &str) -> StorageResult<Option<DepositRecord>>;

    /// Get all deposits with a specific status
    async fn get_by_status(&self, status: DepositStatus) -> StorageResult<Vec<DepositRecord>>;

    /// Get all active deposits (not in terminal states)
    async fn get_active(&self) -> StorageResult<Vec<DepositRecord>>;

    /// Get all deposits
    async fn get_all(&self) -> StorageResult<Vec<DepositRecord>>;

    /// Get failed deposits eligible for retry
    async fn get_failed_for_retry(&self, max_retries: u32) -> StorageResult<Vec<DepositRecord>>;

    /// Delete a deposit by ID
    async fn delete(&self, id: &str) -> StorageResult<bool>;

    /// Get count by status
    async fn count_by_status(&self) -> StorageResult<std::collections::HashMap<String, u64>>;

    /// Get total satoshis received
    async fn total_sats_received(&self) -> StorageResult<u64>;
}

/// Stealth deposit storage interface
///
/// Implementations:
/// - `StealthDepositStore` - In-memory storage (current)
#[async_trait]
pub trait StealthStore: Send + Sync {
    /// Insert a new stealth deposit record
    async fn insert(&self, record: StealthDepositRecord) -> StorageResult<()>;

    /// Update an existing stealth deposit record
    async fn update(&self, record: StealthDepositRecord) -> StorageResult<()>;

    /// Get a record by ID
    async fn get(&self, id: &str) -> StorageResult<Option<StealthDepositRecord>>;

    /// Get a record by BTC address
    async fn get_by_address(&self, btc_address: &str) -> StorageResult<Option<StealthDepositRecord>>;

    /// Get all records with a specific status
    async fn get_by_status(&self, status: StealthDepositStatus) -> StorageResult<Vec<StealthDepositRecord>>;

    /// Get all active records (not in terminal states)
    async fn get_active(&self) -> StorageResult<Vec<StealthDepositRecord>>;

    /// Get all pending deposits
    async fn get_pending(&self) -> StorageResult<Vec<StealthDepositRecord>>;

    /// Get deposits ready to sweep
    async fn get_ready_to_sweep(&self) -> StorageResult<Vec<StealthDepositRecord>>;

    /// Get deposits ready to verify
    async fn get_ready_to_verify(&self) -> StorageResult<Vec<StealthDepositRecord>>;

    /// Get all records
    async fn get_all(&self) -> StorageResult<Vec<StealthDepositRecord>>;

    /// Get count of records
    async fn count(&self) -> StorageResult<usize>;

    /// Delete expired pending deposits
    async fn cleanup_expired(&self) -> StorageResult<u64>;
}

/// Stats for stealth deposits
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
