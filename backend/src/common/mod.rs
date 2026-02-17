//! Common Infrastructure Module
//!
//! Shared utilities and configuration for the zVault backend.
//!
//! This module contains:
//! - Configuration loading from environment variables
//! - Structured logging setup
//! - Common error types

pub mod config;
pub mod error;
pub mod logging;

// Re-exports for convenience
pub use config::{ConfigError, Network, SigningMode, ZVaultConfig};
pub use error::{Result, ZVaultError};
pub use logging::{
    generate_correlation_id, init_from_config, init_logging, log_api_request, log_api_response,
    log_deposit_event, log_security_event, log_withdrawal_event, ErrorDetails, EventCategory,
    LogEvent, LogLevel, LoggingError,
};
