//! Instruction handlers for UTXOpia (Multi-Token Shielded Pool)
//!
//! ## Discriminator Map (sequential 0-19)
//!
//! | Disc | Instruction | Category |
//! |------|-------------|----------|
//! | 0 | `initialize` | Core |
//! | 1 | `set_paused` | Core |
//! | 2 | `set_pool_config` | Core |
//! | 3 | `propose_pool_update` | Pool updates |
//! | 4 | `execute_pool_update` | Pool updates |
//! | 5 | `cancel_pool_update` | Pool updates |
//! | 6 | `init_vk_registry` | VK admin |
//! | 7 | `update_vk_registry` | VK admin |
//! | 8 | `register_token` | Multi-token |
//! | 9 | `update_token_config` | Multi-token |
//! | 10 | `claim_fees` | Multi-token |
//! | 11 | `verify_stealth_deposit` | Deposit |
//! | 12 | `shield` | Deposit |
//! | 13 | `transact` | JoinSplit |
//! | 14 | `unshield` | JoinSplit (multi-output) |
//! | 15 | `redeem` | JoinSplit (multi-output) |
//! | 16 | `request_redemption` | Redemption |
//! | 17 | `complete_redemption` | Redemption |
//! | 18 | `mark_processing` | Redemption |
//! | 19 | `cancel_redemption` | Redemption |

// Core operations
pub mod initialize;
pub mod verify_stealth_deposit;
pub mod register_deposit_intent;
pub mod verify_deposit_v2;
pub mod transact;
pub mod redeem;
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

// Tree management
pub mod rotate_tree;

// Proof of Innocence (Phase 3 — Privacy-Pools-style compliance attestations)
pub mod poi;

// Re-exports
pub use initialize::*;
pub use verify_stealth_deposit::*;
pub use register_deposit_intent::*;
pub use verify_deposit_v2::*;
pub use transact::*;
pub use redeem::*;
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
pub use rotate_tree::*;
pub use poi::*;
