//! State account definitions (zero-copy)
//!
//! ## Core State Accounts
//!
//! | Account | Purpose |
//! |---------|---------|
//! | `PoolState` | Global pool config and statistics |
//! | `CommitmentTree` | Merkle tree of shielded commitments |
//!| `NullifierRecord` | Spent nullifiers (prevents double-spend) |
//! | `RedemptionRequest` | Pending BTC withdrawal request |
//!
//! ## External Account Readers (btc-light-client)
//!
//! | Reader | Purpose |
//! |--------|---------|
//! | `VerifiedTransactionView` | Read-only view of btc-light-client VerifiedTransaction PDA |
//! | `light_client_tip_height` | Read tip height from btc-light-client LightClient |

// Core state
pub mod commitment_tree;
pub mod nullifier;
pub mod pool;
pub mod redemption;
pub mod verified_tx_reader;
pub mod vk_registry;

// Re-exports
pub use commitment_tree::*;
pub use nullifier::*;
pub use pool::*;
pub use redemption::*;
pub use verified_tx_reader::*;
pub use vk_registry::*;

