//! Deposit Tracker Database Module
//!
//! Legacy stealth deposit store has been removed. Deposits are now auto-detected
//! via block scanning and stored in SQLite (sqlite_db.rs).

/// Error type for database operations (kept for backward compatibility)
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("Record not found: {0}")]
    NotFound(String),

    #[error("Duplicate key: {0}")]
    DuplicateKey(String),

    #[error("Invalid data: {0}")]
    InvalidData(String),
}
