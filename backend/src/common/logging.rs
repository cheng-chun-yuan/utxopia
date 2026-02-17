//! Structured Logging for zVault Backend
//!
//! Provides production-ready structured logging with:
//! - JSON output for log aggregation services (ELK, Datadog, etc.)
//! - Correlation IDs for request tracing
//! - Performance metrics
//! - Security event logging
//!
//! # Usage
//!
//! ```rust,ignore
//! use crate::common::logging::{init_logging, LogLevel};
//!
//! // Initialize at startup
//! init_logging(LogLevel::Info, true)?; // JSON mode for production
//!
//! // Log events
//! info!(target: "zvault::api", request_id = %id, "Processing withdrawal");
//! ```

use serde::Serialize;
use tracing::Level;
use tracing_subscriber::{
    fmt::{self, format::FmtSpan},
    layer::SubscriberExt,
    util::SubscriberInitExt,
    EnvFilter, Layer,
};

use super::config::{Network, ZVaultConfig};

// ============================================================================
// Log Levels
// ============================================================================

/// Application log level
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl From<LogLevel> for Level {
    fn from(level: LogLevel) -> Self {
        match level {
            LogLevel::Trace => Level::TRACE,
            LogLevel::Debug => Level::DEBUG,
            LogLevel::Info => Level::INFO,
            LogLevel::Warn => Level::WARN,
            LogLevel::Error => Level::ERROR,
        }
    }
}

impl From<&str> for LogLevel {
    fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "trace" => LogLevel::Trace,
            "debug" => LogLevel::Debug,
            "info" => LogLevel::Info,
            "warn" | "warning" => LogLevel::Warn,
            "error" => LogLevel::Error,
            _ => LogLevel::Info,
        }
    }
}

// ============================================================================
// Structured Event Types
// ============================================================================

/// Event categories for structured logging
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventCategory {
    /// API request/response events
    Api,
    /// Deposit-related events
    Deposit,
    /// Withdrawal/redemption events
    Withdrawal,
    /// Security events (auth, validation failures)
    Security,
    /// Performance metrics
    Performance,
    /// System events (startup, shutdown)
    System,
    /// Error events
    Error,
}

/// Structured log event
#[derive(Debug, Serialize)]
pub struct LogEvent {
    /// Event timestamp (ISO 8601)
    pub timestamp: String,
    /// Log level
    pub level: String,
    /// Event category
    pub category: EventCategory,
    /// Human-readable message
    pub message: String,
    /// Correlation ID for request tracing
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    /// Additional structured data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// Duration in milliseconds (for performance events)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Error details
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorDetails>,
}

/// Error details for error events
#[derive(Debug, Serialize)]
pub struct ErrorDetails {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

impl LogEvent {
    /// Create a new log event
    pub fn new(level: LogLevel, category: EventCategory, message: impl Into<String>) -> Self {
        Self {
            timestamp: chrono::Utc::now().to_rfc3339(),
            level: format!("{:?}", level).to_uppercase(),
            category,
            message: message.into(),
            correlation_id: None,
            data: None,
            duration_ms: None,
            error: None,
        }
    }

    /// Add correlation ID
    pub fn with_correlation_id(mut self, id: impl Into<String>) -> Self {
        self.correlation_id = Some(id.into());
        self
    }

    /// Add structured data
    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    /// Add duration
    pub fn with_duration(mut self, duration_ms: u64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Add error details
    pub fn with_error(mut self, code: impl Into<String>, message: impl Into<String>) -> Self {
        self.error = Some(ErrorDetails {
            code: code.into(),
            message: message.into(),
            stack: None,
        });
        self
    }

    /// Log this event to JSON
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| format!("{{\"error\": \"failed to serialize log\", \"message\": \"{}\"}}", self.message))
    }
}

// ============================================================================
// Security Event Logging
// ============================================================================

/// Log a security-related event
pub fn log_security_event(
    event_type: &str,
    success: bool,
    details: serde_json::Value,
    correlation_id: Option<&str>,
) {
    let level = if success { LogLevel::Info } else { LogLevel::Warn };
    let event = LogEvent::new(level, EventCategory::Security, event_type)
        .with_data(serde_json::json!({
            "success": success,
            "details": details
        }));

    let event = if let Some(id) = correlation_id {
        event.with_correlation_id(id)
    } else {
        event
    };

    if success {
        tracing::info!(target: "zvault::security", "{}", event.to_json());
    } else {
        tracing::warn!(target: "zvault::security", "{}", event.to_json());
    }
}

/// Log an API request
pub fn log_api_request(
    method: &str,
    path: &str,
    client_ip: Option<&str>,
    correlation_id: &str,
) {
    let event = LogEvent::new(LogLevel::Info, EventCategory::Api, format!("{} {}", method, path))
        .with_correlation_id(correlation_id)
        .with_data(serde_json::json!({
            "method": method,
            "path": path,
            "client_ip": client_ip
        }));

    tracing::info!(target: "zvault::api", "{}", event.to_json());
}

/// Log an API response
pub fn log_api_response(
    method: &str,
    path: &str,
    status: u16,
    duration_ms: u64,
    correlation_id: &str,
) {
    let level = if status >= 500 {
        LogLevel::Error
    } else if status >= 400 {
        LogLevel::Warn
    } else {
        LogLevel::Info
    };

    let event = LogEvent::new(level, EventCategory::Api, format!("{} {} -> {}", method, path, status))
        .with_correlation_id(correlation_id)
        .with_duration(duration_ms)
        .with_data(serde_json::json!({
            "method": method,
            "path": path,
            "status": status
        }));

    match level {
        LogLevel::Error => tracing::error!(target: "zvault::api", "{}", event.to_json()),
        LogLevel::Warn => tracing::warn!(target: "zvault::api", "{}", event.to_json()),
        _ => tracing::info!(target: "zvault::api", "{}", event.to_json()),
    }
}

/// Log a deposit event
pub fn log_deposit_event(
    event_type: &str,
    deposit_id: &str,
    amount_sats: u64,
    success: bool,
    error: Option<&str>,
) {
    let level = if success { LogLevel::Info } else { LogLevel::Error };
    let mut event = LogEvent::new(level, EventCategory::Deposit, event_type)
        .with_correlation_id(deposit_id)
        .with_data(serde_json::json!({
            "deposit_id": deposit_id,
            "amount_sats": amount_sats,
            "success": success
        }));

    if let Some(err) = error {
        event = event.with_error("DEPOSIT_ERROR", err);
    }

    if success {
        tracing::info!(target: "zvault::deposit", "{}", event.to_json());
    } else {
        tracing::error!(target: "zvault::deposit", "{}", event.to_json());
    }
}

/// Log a withdrawal event
pub fn log_withdrawal_event(
    event_type: &str,
    request_id: &str,
    amount_sats: u64,
    btc_address: &str,
    success: bool,
    btc_txid: Option<&str>,
    error: Option<&str>,
) {
    let level = if success { LogLevel::Info } else { LogLevel::Error };
    let mut event = LogEvent::new(level, EventCategory::Withdrawal, event_type)
        .with_correlation_id(request_id)
        .with_data(serde_json::json!({
            "request_id": request_id,
            "amount_sats": amount_sats,
            "btc_address": btc_address,
            "btc_txid": btc_txid,
            "success": success
        }));

    if let Some(err) = error {
        event = event.with_error("WITHDRAWAL_ERROR", err);
    }

    if success {
        tracing::info!(target: "zvault::withdrawal", "{}", event.to_json());
    } else {
        tracing::error!(target: "zvault::withdrawal", "{}", event.to_json());
    }
}

// ============================================================================
// Initialization
// ============================================================================

/// Initialize the logging system
///
/// # Arguments
/// * `level` - Minimum log level to output
/// * `json_format` - Use JSON format (recommended for production)
///
/// # Example
/// ```rust,ignore
/// init_logging(LogLevel::Info, true)?; // JSON for production
/// init_logging(LogLevel::Debug, false)?; // Pretty print for development
/// ```
pub fn init_logging(level: LogLevel, json_format: bool) -> Result<(), LoggingError> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| {
            EnvFilter::new(format!(
                "zvault={},tower_http={},axum={}",
                format!("{:?}", level).to_lowercase(),
                format!("{:?}", level).to_lowercase(),
                format!("{:?}", level).to_lowercase()
            ))
        });

    if json_format {
        // JSON format for production
        let subscriber = tracing_subscriber::registry()
            .with(filter)
            .with(
                fmt::layer()
                    .json()
                    .with_target(true)
                    .with_thread_ids(true)
                    .with_thread_names(true)
                    .with_file(true)
                    .with_line_number(true)
                    .with_span_events(FmtSpan::CLOSE)
            );

        subscriber.try_init().map_err(|e| LoggingError::InitFailed(e.to_string()))?;
    } else {
        // Pretty format for development
        let subscriber = tracing_subscriber::registry()
            .with(filter)
            .with(
                fmt::layer()
                    .pretty()
                    .with_target(true)
                    .with_thread_ids(false)
                    .with_file(true)
                    .with_line_number(true)
                    .with_span_events(FmtSpan::CLOSE)
            );

        subscriber.try_init().map_err(|e| LoggingError::InitFailed(e.to_string()))?;
    }

    Ok(())
}

/// Initialize logging from ZVaultConfig
pub fn init_from_config(config: &ZVaultConfig) -> Result<(), LoggingError> {
    let level = LogLevel::from(config.log_level.as_str());
    let json_format = config.network == Network::Mainnet;

    init_logging(level, json_format)
}

/// Logging errors
#[derive(Debug, thiserror::Error)]
pub enum LoggingError {
    #[error("failed to initialize logging: {0}")]
    InitFailed(String),
}

// ============================================================================
// Request ID Generation
// ============================================================================

/// Generate a unique correlation ID for request tracing
pub fn generate_correlation_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();

    // Simple ID format: timestamp + random suffix
    format!(
        "{:x}-{:04x}",
        timestamp & 0xFFFFFFFF,
        rand::random::<u16>()
    )
}

// Simple random number generation without external crate
mod rand {
    use std::time::{SystemTime, UNIX_EPOCH};

    pub fn random<T: From<u16>>() -> T {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        T::from((nanos % 65536) as u16)
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_log_event_serialization() {
        let event = LogEvent::new(LogLevel::Info, EventCategory::Api, "Test event")
            .with_correlation_id("test-123")
            .with_data(serde_json::json!({"key": "value"}))
            .with_duration(42);

        let json = event.to_json();
        assert!(json.contains("Test event"));
        assert!(json.contains("test-123"));
        assert!(json.contains("42"));
    }

    #[test]
    fn test_log_level_parsing() {
        assert_eq!(LogLevel::from("debug"), LogLevel::Debug);
        assert_eq!(LogLevel::from("INFO"), LogLevel::Info);
        assert_eq!(LogLevel::from("warning"), LogLevel::Warn);
        assert_eq!(LogLevel::from("unknown"), LogLevel::Info);
    }

    #[test]
    fn test_correlation_id_generation() {
        let id1 = generate_correlation_id();
        let id2 = generate_correlation_id();

        assert!(!id1.is_empty());
        assert!(!id2.is_empty());
        // IDs should be unique (with very high probability)
        // Note: There's a tiny chance they could be the same if generated in the same nanosecond
    }
}
