//! Instruction handlers for Aegis (JoinSplit Architecture)
//!
//! ## Core Operations
//!
//! | Instruction | Purpose |
//! |-------------|---------|
//! | `initialize` | Setup pool state and commitment tree |
//! | `verify_stealth_deposit` | Verify BTC via SPV, create stealth announcement, mint to pool |
//! | `transact` | JoinSplit N-to-M private transfer (Groth16) |
//! | `request_redemption` | Prove ownership, burn from pool, queue BTC withdrawal |
//! | `complete_redemption` | Relayer marks redemption complete |
//!
//! ## Demo Operations (Testing only)
//!
//! | Instruction | Purpose |
//! |-------------|---------|
//! | `add_demo_stealth` | Add stealth deposit without real BTC |

// Core operations (JoinSplit Architecture)
pub mod initialize;
pub mod verify_stealth_deposit;
pub mod transact;
pub mod request_redemption;
pub mod mark_processing;
pub mod cancel_redemption;
pub mod complete_redemption;

// Public unshield (zkBTC → SPL token)
pub mod unshield;

// Redeem: JoinSplit → BTC withdrawal
pub mod redeem;

// Public redeem: burn SPL → BTC withdrawal
pub mod public_redeem;

// Demo/testing
pub mod add_demo_stealth;

// OP_RETURN-free deposit flow
pub mod register_deposit_intent;
pub mod verify_deposit_v2;

// Admin utilities
pub mod admin_update_pool; // propose/execute/cancel pool updates (timelocked)

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
pub use unshield::*;
pub use redeem::*;
pub use public_redeem::*;
pub use add_demo_stealth::*;
pub use register_deposit_intent::*;
pub use verify_deposit_v2::*;
pub use admin_update_pool::*;
pub use init_vk_registry::*;
