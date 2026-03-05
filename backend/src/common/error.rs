//! Common Error Types for Aegis Backend
//!
//! Provides unified error handling across all modules.

use thiserror::Error;

/// Root error type for Aegis backend
#[derive(Debug, Error)]
pub enum AegisError {
    /// Configuration errors
    #[error("configuration error: {0}")]
    Config(#[from] crate::config::ConfigError),

    /// Logging errors
    #[error("logging error: {0}")]
    Logging(#[from] super::logging::LoggingError),

    /// Bitcoin-related errors
    #[error("bitcoin error: {0}")]
    Bitcoin(String),

    /// Solana-related errors
    #[error("solana error: {0}")]
    Solana(String),

    /// Storage errors
    #[error("storage error: {0}")]
    Storage(String),

    /// API errors
    #[error("API error: {0}")]
    Api(String),

    /// Service errors
    #[error("service error: {0}")]
    Service(String),

    /// Validation errors
    #[error("validation error: {0}")]
    Validation(String),

    /// Internal errors
    #[error("internal error: {0}")]
    Internal(String),

    /// IO errors
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl AegisError {
    /// Create a Bitcoin error
    pub fn bitcoin(msg: impl Into<String>) -> Self {
        Self::Bitcoin(msg.into())
    }

    /// Create a Solana error
    pub fn solana(msg: impl Into<String>) -> Self {
        Self::Solana(msg.into())
    }

    /// Create a storage error
    pub fn storage(msg: impl Into<String>) -> Self {
        Self::Storage(msg.into())
    }

    /// Create an API error
    pub fn api(msg: impl Into<String>) -> Self {
        Self::Api(msg.into())
    }

    /// Create a service error
    pub fn service(msg: impl Into<String>) -> Self {
        Self::Service(msg.into())
    }

    /// Create a validation error
    pub fn validation(msg: impl Into<String>) -> Self {
        Self::Validation(msg.into())
    }

    /// Create an internal error
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }

    /// Check if this is a retryable error
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            AegisError::Bitcoin(_)
                | AegisError::Solana(_)
                | AegisError::Storage(_)
                | AegisError::Io(_)
        )
    }

    /// Get error code for API responses
    pub fn error_code(&self) -> &'static str {
        match self {
            AegisError::Config(_) => "CONFIG_ERROR",
            AegisError::Logging(_) => "LOGGING_ERROR",
            AegisError::Bitcoin(_) => "BITCOIN_ERROR",
            AegisError::Solana(_) => "SOLANA_ERROR",
            AegisError::Storage(_) => "STORAGE_ERROR",
            AegisError::Api(_) => "API_ERROR",
            AegisError::Service(_) => "SERVICE_ERROR",
            AegisError::Validation(_) => "VALIDATION_ERROR",
            AegisError::Internal(_) => "INTERNAL_ERROR",
            AegisError::Io(_) => "IO_ERROR",
        }
    }
}

/// Result type alias using AegisError
pub type Result<T> = std::result::Result<T, AegisError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_creation() {
        let err = AegisError::bitcoin("connection failed");
        assert!(err.to_string().contains("connection failed"));
        assert_eq!(err.error_code(), "BITCOIN_ERROR");
    }

    #[test]
    fn test_retryable_errors() {
        assert!(AegisError::bitcoin("timeout").is_retryable());
        assert!(AegisError::solana("rpc failed").is_retryable());
        assert!(!AegisError::validation("invalid input").is_retryable());
    }
}
