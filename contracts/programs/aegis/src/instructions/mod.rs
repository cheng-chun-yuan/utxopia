//! Instruction handlers for Aegis (Multi-Token Shielded Pool)
//!
//! ## Core Operations
//!
//! | Instruction | Disc | Purpose |
//! |-------------|------|---------|
//! | `initialize` | 0 | Setup pool state and commitment tree |
//! | `verify_stealth_deposit` | 1 | Verify BTC via SPV, create commitment |
//! | `transact` | 14 | JoinSplit N-to-M private transfer (Groth16) |
//! | `request_redemption` | 5 | Queue BTC withdrawal with escrow |
//! | `complete_redemption` | 6 | Relayer marks redemption complete |
//!
//! ## Multi-Token Operations
//!
//! | Instruction | Disc | Purpose |
//! |-------------|------|---------|
//! | `register_token` | 28 | Admin registers SPL token for shielding |
//! | `shield` | 29 | User deposits SPL token → shielded commitment |
//! | `unshield` | 30 | User withdraws SPL token via ZK proof |
//! | `update_token_config` | 31 | Admin updates per-token config |
//! | `claim_fees` | 32 | Admin claims accumulated per-token fees |

// Core operations
pub mod initialize;
pub mod verify_stealth_deposit;
pub mod transact;
pub mod request_redemption;
pub mod mark_processing;
pub mod cancel_redemption;
pub mod complete_redemption;

// Multi-token operations
pub mod register_token;
pub mod shield;
pub mod unshield;
pub mod update_token_config;
pub mod claim_fees;

// Admin utilities
pub mod admin_update_pool;
pub mod set_pool_config;

// VK registry (deployment)
pub mod init_vk_registry;

// Re-exports
pub use initialize::*;
pub use verify_stealth_deposit::*;
pub use transact::*;
pub use request_redemption::*;
pub use mark_processing::*;
pub use cancel_redemption::*;
pub use complete_redemption::*;
pub use register_token::*;
pub use shield::*;
pub use unshield::*;
pub use update_token_config::*;
pub use claim_fees::*;
pub use admin_update_pool::*;
pub use set_pool_config::*;
pub use init_vk_registry::*;
