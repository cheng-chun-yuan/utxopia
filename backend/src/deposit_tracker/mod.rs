//! Deposit Tracker Module
//!
//! Tracks Bitcoin deposits through their complete lifecycle:
//!
//! ```text
//! PENDING → DETECTED → CONFIRMING → CONFIRMED → SWEEPING → SWEEP_CONFIRMING → VERIFYING → READY → CLAIMED
//! ```
//!
//! ## Components
//!
//! - **types**: Data structures for deposits, status, and API types
//! - **watcher**: Polls Esplora for Bitcoin transactions
//! - **sweeper**: Sweeps UTXOs from deposit addresses to pool wallet
//! - **verifier**: Submits SPV proofs to Solana for verification
//! - **websocket**: Real-time status updates via WebSocket
//! - **service**: Main service orchestrating all components
//! - **api**: REST and WebSocket API endpoints
//!
//! ## Flow Overview
//!
//! 1. User generates deposit address (via SDK)
//! 2. User registers deposit with backend (POST /api/deposits)
//! 3. Service polls Esplora for incoming transactions
//! 4. After 6 confirmations, service sweeps UTXO to pool wallet
//! 5. After 2 sweep confirmations, service submits SPV proof to Solana
//! 6. User can claim zkBTC once status is "ready"
//!
//! ## API Endpoints
//!
//! - `POST /api/deposits` - Register a deposit to track
//! - `GET /api/deposits/:id` - Get deposit status
//! - `WS /ws/deposits/:id` - Subscribe to status updates

pub mod api;
pub mod db;
pub mod service;
pub mod sqlite_db;
pub mod sweeper;
pub mod types;
pub mod verifier;
pub mod watcher;
pub mod websocket;

// Re-exports
pub use api::{create_deposit_router, start_tracker_server, AppState, SharedAppState};
pub use service::{
    create_tracker_service, DepositTrackerService, SharedTrackerService, TrackerError,
};
pub use sweeper::{SweepResult, SweeperError, UtxoSweeper};
pub use types::{
    DepositRecord, DepositStatus, DepositStatusResponse, DepositStatusUpdate,
    RegisterDepositRequest, RegisterDepositResponse, TrackerConfig, TrackerStats,
    // V2 stealth deposit types
    PrepareStealthDepositRequest, PrepareStealthDepositResponse,
    StealthDepositRecord, StealthDepositStatus, StealthDepositStatusResponse,
    StealthDepositStatusUpdate,
};
pub use verifier::{SpvVerifier, VerificationResult, VerifierError};
pub use watcher::{AddressWatcher, BlockHeaderData, MerkleProofData, Utxo, WatcherError};
pub use websocket::{
    create_ws_state, ws_all_deposits_handler, ws_deposit_handler, DepositUpdatePublisher,
    SharedWebSocketState, WebSocketState,
};
pub use db::{DbError, StealthDepositStats, StealthDepositStore};
pub use sqlite_db::{SqliteDepositStore, SqliteError};
