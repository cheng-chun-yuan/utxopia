//! UTXOpia Backend
//!
//! Server-side services for the privacy-preserving Bitcoin-to-Solana bridge.
//!
//! ## Services
//!
//! - **Deposit Tracker** - Watches BTC deposits, sweeps UTXOs, submits SPV proofs
//! - **Header Relayer** - Submits Bitcoin headers to Solana light client
//! - **Redemption Processor** - Signs and broadcasts BTC withdrawals
//! - **Event Indexer** - Indexes on-chain Merkle tree events
//! - **Stealth Service** - Stealth deposit address preparation
//!
//! ## Module Organization
//!
//! - `common/` - Logging, error handling
//! - `bitcoin/` - Esplora client, signing, taproot, SPV
//! - `solana/` - Solana RPC client
//! - `api/` - Middleware and validation
//! - `deposit_tracker/` - Full deposit lifecycle
//! - `redemption/` - BTC withdrawal processing
//! - `event_indexer/` - On-chain event indexing
//! - `stealth/` - Stealth deposit service

pub mod constants;
pub mod common;
pub mod bitcoin;
pub mod solana;
pub mod api;
pub mod event_indexer;
pub mod merkle_tree;
pub mod api_server;
pub mod config;
pub mod deposit_tracker;
pub mod redemption;
pub mod stealth;
pub mod poi_service;

// Re-exports: Configuration
pub use config::{ConfigError, Network, SigningMode, UTXOpiaConfig};

// Re-exports: Middleware (from api module)
pub use api::middleware::{
    create_rate_limiter, validate_btc_address, validate_solana_address, validate_amount_sats,
    validate_hex, RateLimitConfig, RateLimitState, ValidationError, ValidationResult,
};

// Re-exports: Logging (from common module)
pub use common::logging::{
    init_logging, init_from_config, log_api_request, log_api_response, log_deposit_event,
    log_security_event, log_withdrawal_event, generate_correlation_id, EventCategory,
    LogEvent, LogLevel, LoggingError,
};

// Re-exports: Bitcoin signer
pub use bitcoin::signer::{FrostConfig, Signer, SignerError, SingleKeySigner};

// Re-exports: Solana client
pub use solana::client::{
    generate_keypair as generate_sol_keypair, load_keypair_from_file, SolClient, SolConfig,
    SolError, DEVNET_RPC,
};

// Re-exports: Esplora client
pub use bitcoin::client::{EsploraClient, EsploraError, EsploraTxStatus};

// Re-exports: Redemption service
pub use redemption::{
    PoolUtxo, RedemptionConfig, RedemptionService, RedemptionStats, WithdrawalRequest,
    WithdrawalStatus,
};

// Re-exports: Bitcoin SPV
pub use bitcoin::spv::{BlockHeader, SpvError, SpvProof, SpvProofGenerator, TxDetails, TxMerkleProof};

// Re-exports: Taproot
pub use bitcoin::taproot::{
    generate_deposit_address, get_unlock_criteria, PoolKeys, TaprootDeposit, TaprootError,
    UnlockCriteria,
};

pub use deposit_tracker::{
    create_tracker_service, create_ws_state, DepositRecord, DepositStatus, DepositStatusResponse,
    DepositTrackerService, SharedTrackerService,
    TrackerConfig, TrackerError, TrackerStats,
};

pub use event_indexer::{
    EventStore, EventIndexerService, event_indexer_router, event_indexer_router_with_deposits, TreeCache,
};

pub use stealth::{
    create_stealth_router, create_stealth_service, start_stealth_server, PrepareStealthRequest,
    SharedStealthService, StealthData, StealthDepositRecord, StealthDepositService,
    StealthDepositStatus, StealthError, StealthMode, StealthStatusResponse,
};

/// Satoshi conversion helpers
pub mod units {
    pub const SATS_PER_BTC: u64 = 100_000_000;

    /// Convert BTC to satoshis with proper rounding
    pub fn btc_to_sats(btc: f64) -> u64 {
        (btc * SATS_PER_BTC as f64).round() as u64
    }

    pub fn sats_to_btc(sats: u64) -> f64 {
        sats as f64 / SATS_PER_BTC as f64
    }

    pub fn format_sats(sats: u64) -> String {
        let btc = sats_to_btc(sats);
        format!("{} sats ({:.8} BTC)", sats, btc)
    }
}
