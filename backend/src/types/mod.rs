//! Shared Types Module
//!
//! Data types shared across the zVault backend.

pub mod deposit;
pub mod redemption;
pub mod stealth;
pub mod units;

// Re-exports for convenience
pub use deposit::{
    DepositRecord, DepositStatus, DepositStatusResponse, DepositStatusUpdate,
    RegisterDepositRequest, RegisterDepositResponse, TrackerConfig, TrackerStats,
};
pub use redemption::{
    BurnEvent, PoolUtxo, RedemptionConfig, RedemptionStats, WithdrawalRequest, WithdrawalStatus,
};
pub use stealth::{
    PrepareStealthDepositRequest, PrepareStealthDepositResponse, StealthData,
    StealthDepositRecord, StealthDepositStatus, StealthDepositStatusResponse,
    StealthDepositStatusUpdate, StealthMode,
};
pub use units::{btc_to_sats, parse_btc, parse_sats, sats_to_btc_string, sats_to_display, SATS_PER_BTC};
