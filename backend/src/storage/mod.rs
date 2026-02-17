//! Storage Layer Module
//!
//! Provides persistence for deposit and stealth records.
//!
//! This module contains:
//! - Storage trait definitions for abstraction
//! - SQLite implementation for production
//! - In-memory implementation for testing

pub mod memory;
pub mod sqlite;
pub mod traits;

// Re-exports for convenience
pub use memory::StealthDepositStore;
pub use sqlite::SqliteDepositStore;
pub use traits::{DepositStore, StealthDepositStats, StealthStore, StorageError, StorageResult};
