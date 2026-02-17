//! Instruction handlers for zVault (Unified Stealth Model)
//!
//! ## Core Operations
//!
//! | Instruction | Purpose |
//! |-------------|---------|
//! | `initialize` | Setup pool state and commitment tree |
//! | `verify_stealth_deposit` | Verify BTC via SPV, create stealth announcement, mint to pool |
//! | `spend_split` | Split 1 commitment into 2 (spend_split circuit) |
//! | `spend_partial_public` | Partial public claim with change (spend_partial_public circuit) |
//! | `claim` | Full claim to public wallet (claim circuit) |
//! | `request_redemption` | Prove ownership, burn from pool, queue BTC withdrawal |
//! | `complete_redemption` | Relayer marks redemption complete |
//!
//! ## Demo Operations (Testing only)
//!
//! | Instruction | Purpose |
//! |-------------|---------|
//! | `add_demo_stealth` | Add stealth deposit without real BTC |

// Core operations (Unified Stealth Model)
pub mod initialize;
pub mod verify_stealth_deposit;
pub mod spend_split;
pub mod spend_partial_public;
pub mod claim;
pub mod request_redemption;
pub mod complete_redemption;

// Demo/testing
pub mod add_demo_stealth;

// Name registry
pub mod register_name;

// VK registry (deployment)
pub mod init_vk_registry;

// Re-exports
pub use initialize::*;
pub use verify_stealth_deposit::*;
pub use spend_split::*;
pub use spend_partial_public::*;
pub use claim::*;
pub use request_redemption::*;
pub use complete_redemption::*;
pub use add_demo_stealth::*;
pub use register_name::*;

// VK registry re-exports
pub use init_vk_registry::*;
