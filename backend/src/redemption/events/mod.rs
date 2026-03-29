//! Event-driven account update streams for redemption processing.
//!
//! Architecture:
//! ```text
//!   AccountUpdateStream (trait)
//!     │
//!     ├── PollingStream     — getProgramAccounts every N seconds (fallback)
//!     └── WebSocketStream   — programSubscribe real-time (devnet/testnet)
//!     └── (future) GeyserStream — Yellowstone gRPC (mainnet)
//! ```
//!
//! All implementations produce the same `AccountUpdate` events.
//! The redemption service consumes events regardless of transport.

pub mod polling;
pub mod websocket;

use std::fmt;

/// A single account change event from any transport.
#[derive(Debug, Clone)]
pub struct AccountUpdate {
    /// Base58 account public key
    pub pubkey: String,
    /// Raw account data bytes
    pub data: Vec<u8>,
    /// Account data length
    pub data_len: usize,
    /// Slot at which the update occurred (0 if unknown)
    pub slot: u64,
}

/// Errors from stream operations
#[derive(Debug)]
pub enum StreamError {
    ConnectionFailed(String),
    Disconnected(String),
    ParseError(String),
}

impl fmt::Display for StreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StreamError::ConnectionFailed(msg) => write!(f, "connection failed: {}", msg),
            StreamError::Disconnected(msg) => write!(f, "disconnected: {}", msg),
            StreamError::ParseError(msg) => write!(f, "parse error: {}", msg),
        }
    }
}

impl std::error::Error for StreamError {}

/// Callback type for account updates.
pub type UpdateCallback = Box<dyn Fn(AccountUpdate) + Send + Sync>;

/// Transport-agnostic account update stream.
///
/// Implementations:
/// - `PollingStream`: getProgramAccounts on interval (fallback)
/// - `WebSocketStream`: Solana programSubscribe (devnet)
/// - Future: `GeyserStream` for Yellowstone gRPC (mainnet)
#[async_trait::async_trait]
pub trait AccountUpdateStream: Send + Sync {
    /// Start streaming account updates. Blocks until stopped or error.
    async fn start(&self, callback: UpdateCallback) -> Result<(), StreamError>;

    /// Stop the stream gracefully.
    async fn stop(&self);

    /// Human-readable name for logging.
    fn name(&self) -> &str;
}
