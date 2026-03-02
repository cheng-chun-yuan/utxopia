//! Deposit Tracker Module
//!
//! Tracks Bitcoin deposits through their complete lifecycle:
//!
//! ```text
//! DETECTED → CONFIRMING → CONFIRMED → SWEEPING → SWEEP_CONFIRMING → VERIFYING → READY → CLAIMED
//! ```
//!
//! ## Components
//!
//! - **types**: Data structures for deposits, status, and API types
//! - **watcher**: Polls Esplora for Bitcoin transactions and block data
//! - **sweeper**: Sweeps UTXOs from deposit addresses to pool wallet
//! - **verifier**: Submits SPV proofs to Solana for verification
//! - **websocket**: Real-time status updates via WebSocket
//! - **service**: Main service orchestrating all components
//! - **api**: REST and WebSocket API endpoints
//!
//! ## Flow Overview
//!
//! 1. Service scans new blocks for transactions with 64-byte OP_RETURN (ephemeralPub + npk)
//! 2. Verifies P2TR output matches pool_key tweaked with npk from OP_RETURN
//! 3. Auto-registers deposit (no API registration needed)
//! 4. After confirmation, sweeps UTXO to pool wallet
//! 5. After sweep confirms, submits SPV proof to Solana
//! 6. User can claim zkBTC once status is "ready"

pub mod api;
pub mod db;
pub mod header_relayer;
pub mod service;
pub mod sqlite_db;
pub mod sweeper;
pub mod types;
pub mod verifier;
pub mod watcher;
pub mod websocket;
pub mod ws_listener;

// Re-exports
pub use api::{create_deposit_router, start_tracker_server, AppState, SharedAppState};
pub use service::{
    create_tracker_service, DepositTrackerService, SharedTrackerService, TrackerError,
};
pub use sweeper::{SweepResult, SweeperError, UtxoSweeper};
pub use types::{
    DepositRecord, DepositStatus, DepositStatusResponse, DepositStatusUpdate,
    TrackerConfig, TrackerStats,
};
pub use verifier::{SpvVerifier, VerificationResult, VerifierError};
pub use watcher::{AddressWatcher, BlockHeaderData, MerkleProofData, Utxo, WatcherError};
pub use websocket::{
    create_ws_state, ws_all_deposits_handler, ws_deposit_handler, DepositUpdatePublisher,
    SharedWebSocketState, WebSocketState,
};
pub use db::DbError;
pub use header_relayer::HeaderRelayer;
pub use sqlite_db::{SqliteDepositStore, SqliteError};
pub use ws_listener::{MempoolWsListener, WsEvent};
