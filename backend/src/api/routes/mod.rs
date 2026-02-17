//! API Routes Module
//!
//! Contains route handlers organized by domain:
//! - health: Health check and monitoring endpoints
//! - deposits: Deposit tracking endpoints
//! - redemption: Withdrawal/redemption endpoints
//! - stealth: Stealth deposit endpoints

// Re-export from existing modules for now
// In a future refactor, route handlers would be moved here

// Route modules would be:
// pub mod health;
// pub mod deposits;
// pub mod redemption;
// pub mod stealth;

// For now, routes are defined in:
// - deposit_tracker/api.rs (deposit routes)
// - api.rs (redemption and stealth routes)
