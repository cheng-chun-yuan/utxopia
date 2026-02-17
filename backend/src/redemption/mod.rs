//! Redemption Service
//!
//! Processes zBTC burns on Solana and triggers BTC withdrawals.
//!
//! # Flow
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────┐
//! │                    REDEMPTION FLOW                              │
//! ├─────────────────────────────────────────────────────────────────┤
//! │                                                                 │
//! │  1. User burns zBTC on Solana                                 │
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
//! ```rust,ignore
//! use zkbtc::redemption::RedemptionService;
//!
//! #[tokio::main]
//! async fn main() {
//!     let service = RedemptionService::new_testnet();
//!
//!     // Submit withdrawal request
//!     let id = service.submit_withdrawal(
//!         "sol_burn_tx",
//!         "user_pubkey",
//!         100_000, // sats
//!         "tb1q...",
//!     ).await?;
//!
//!     // Run the service
//!     service.run().await?;
//! }
//! ```

pub mod builder;
pub mod queue;
pub mod service;
pub mod signer;
pub mod types;
pub mod watcher;

// Re-exports
pub use builder::{BuilderError, TxBuilder, UnsignedTx};
pub use queue::{QueueError, QueueStats, WithdrawalQueue};
pub use service::{ProcessResult, RedemptionService, ServiceError, TickResult};
pub use signer::{MpcSigner, SignerError, SingleKeySigner, TxSigner};
pub use types::{
    BurnEvent, PoolUtxo, RedemptionConfig, RedemptionStats, WithdrawalRequest, WithdrawalStatus,
};
pub use watcher::{BurnWatcher, WatcherError};
