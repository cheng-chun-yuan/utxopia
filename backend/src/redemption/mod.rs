//! Redemption Service
//!
//! Processes zkBTC burns on Solana and triggers BTC withdrawals.
//!
//! # Flow
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────┐
//! │                    REDEMPTION FLOW                              │
//! ├─────────────────────────────────────────────────────────────────┤
//! │                                                                 │
//! │  1. User burns zkBTC on Solana                                 │
//! │     └── Calls: request_redemption(amount, btc_address)         │
//! │                                                                 │
//! │  2. Service detects burn event                                  │
//! │     └── Watches: Solana program logs                           │
//! │                                                                 │
//! │  3. Service creates BTC transaction                             │
//! │     └── Input: Pool UTXO                                       │
//! │     └── Output: User's BTC address                             │
//! │                                                                 │
//! │  4. Service signs transaction                                   │
//! │     └── POC: Single key                                         │
//! │     └── Production: FROST MPC                                   │
//! │                                                                 │
//! │  5. Service broadcasts transaction                              │
//! │     └── Via: Esplora API                                        │
//! │                                                                 │
//! │  6. Service updates status                                      │
//! │     └── Tracks: Confirmations until complete                   │
//! │                                                                 │
//! └─────────────────────────────────────────────────────────────────┘
//! ```
//!
//! # Usage
//!
//! ```rust,no_run
//! use zkbtc::redemption::RedemptionService;
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let service = RedemptionService::new_testnet();
//!
//!     // Submit withdrawal request
//!     let id = service.submit_withdrawal(
//!         "sol_burn_tx".to_string(),
//!         "user_pubkey".to_string(),
//!         100_000, // sats
//!         "tb1q...".to_string(),
//!         None,
//!     ).await?;
//!
//!     // Run the service
//!     service.run().await?;
//!     Ok(())
//! }
//! ```

pub mod builder;
pub mod events;
pub mod queue;
pub mod service;
pub mod signer;
pub mod tracking;
pub mod types;
pub mod watcher;

// Re-exports
pub use builder::{BuilderError, TxBuilder, UnsignedTx};
pub use events::{AccountUpdate, AccountUpdateStream, StreamError};
pub use queue::{QueueError, QueueStats, WithdrawalQueue};
pub use service::{ProcessResult, RedemptionService, ServiceError, TickResult};
pub use signer::{MpcSigner, SignerError, SingleKeySigner, TxSigner};
pub use types::{
    BurnEvent, PoolUtxo, RedemptionConfig, RedemptionStats, WithdrawalRequest, WithdrawalStatus,
};
pub use tracking::TrackingStore;
pub use watcher::{RedemptionScanner, ScanResult, ScannerError};
