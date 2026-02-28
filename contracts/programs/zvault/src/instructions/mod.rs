//! Instruction handlers for zVault (JoinSplit Architecture)
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

// Demo/testing
pub mod add_demo_stealth;

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
pub use add_demo_stealth::*;
pub use init_vk_registry::*;
