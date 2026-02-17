//! Domain Services Module
//!
//! Contains the core business logic services for zVault:
//! - Deposit tracking and processing
//! - Redemption/withdrawal handling
//! - Stealth deposit management
//!
//! Note: Currently re-exports from the legacy module locations.
//! The actual service implementations remain in deposit_tracker/, redemption/, and stealth/.

// Re-export from existing modules for now
// In a future refactor, these would be moved to services/{deposit,redemption,stealth}/

pub mod deposit {
    //! Deposit tracking services
    //!
    //! Tracks Bitcoin deposits through their lifecycle and verifies them on Solana.

    pub use crate::deposit_tracker::*;
}

pub mod redemption {
    //! Redemption/withdrawal services
    //!
    //! Processes zBTC burns and sends BTC back to users.

    pub use crate::redemption::*;
}

pub mod stealth {
    //! Stealth deposit services
    //!
    //! Handles privacy-preserving stealth address deposits.

    pub use crate::stealth::*;
}
