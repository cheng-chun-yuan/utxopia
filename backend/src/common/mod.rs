//! Common Infrastructure Module
//!
//! Shared utilities for the zVault backend.
//!
//! This module contains:
//! - Structured logging setup
//! - Common error types
//!
//! Configuration lives in `crate::config` (single source of truth).

pub mod error;
pub mod logging;

// Re-export config types from crate::config for convenience
pub use crate::config::{ConfigError, Network, SigningMode, ZVaultConfig};
pub use error::{Result, ZVaultError};
pub use logging::{
    generate_correlation_id, init_from_config, init_logging, log_api_request, log_api_response,
    log_deposit_event, log_security_event, log_withdrawal_event, ErrorDetails, EventCategory,
    LogEvent, LogLevel, LoggingError,
};
