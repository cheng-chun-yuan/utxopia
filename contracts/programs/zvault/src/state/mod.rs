//! State account definitions (zero-copy)
//!
//! ## Core State Accounts
//!
//! | Account | Purpose |
//! |---------|---------|
//! | `PoolState` | Global pool config and statistics |
//! | `CommitmentTree` | Merkle tree of shielded commitments |
//! | `DepositRecord` | Individual BTC deposit record |
//! | `NullifierRecord` | Spent nullifiers (prevents double-spend) |
//! | `RedemptionRequest` | Pending BTC withdrawal request |
//! | `BitcoinLightClient` | Bitcoin header chain state |
//! | `BlockHeader` | Individual Bitcoin block header |
//! | `StealthAnnouncement` | Stealth address announcement (dual-key ECDH) |

// Core state
pub mod block_header;
pub mod btc_light_client;
pub mod commitment_tree;
pub mod deposit;
pub mod name_registry;
pub mod nullifier;
pub mod pool;
pub mod redemption;
pub mod reverse_registry;
pub mod stealth_announcement;
pub mod vk_registry;


// Re-exports
pub use block_header::*;
pub use btc_light_client::*;
pub use commitment_tree::*;
pub use deposit::*;
pub use name_registry::*;
pub use nullifier::*;
pub use pool::*;
pub use redemption::*;
pub use reverse_registry::*;
pub use stealth_announcement::*;
pub use vk_registry::*;

