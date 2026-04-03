//! Common Infrastructure Module
//!
//! Shared utilities for the Privacy Coin backend.
//!
//! This module contains:
//! - Structured logging setup
//! - Common error types
//!
//! Configuration lives in `crate::config` (single source of truth).

pub mod cors;
pub mod crypto;
pub mod env;
pub mod error;
pub mod http;
pub mod keypair;
pub mod logging;
pub mod reconnect;
pub mod ws;

// Re-export config types from crate::config for convenience
pub use crate::config::{ConfigError, Network, SigningMode, PRIVACY_COINConfig};
pub use error::{Result, PrivacyCoinError};
pub use logging::{
    generate_correlation_id, init_from_config, init_logging, log_api_request, log_api_response,
    log_deposit_event, log_security_event, log_withdrawal_event, ErrorDetails, EventCategory,
    LogEvent, LogLevel, LoggingError,
};
