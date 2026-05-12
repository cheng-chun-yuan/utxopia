//! Shared constants for the UTXOpia backend.

// =============================================================================
// Pool State Layout Offsets (matches contracts/programs/utxopia/src/state/pool.rs)
// =============================================================================

/// PoolState byte offsets for zero-copy deserialization.
/// Layout: disc(1) bump(1) flags(1) pad(1) authority(32) mint(32)
///         poolVault(32) frostVault(32) depositCount(8)@132 totalMinted(8)@140
///         totalBurned(8)@148 pendingRedemptions(8)@156 lastUpdate(8)@164
///         minDeposit(8)@172 maxDeposit(8)@180 totalShielded(8)@188
///         serviceFeeBase(8)@196 feePool(8)@204 pendingMinDeposit(8)@212
///         pendingMaxDeposit(8)@220 pendingServiceFee(8)@228
///         pendingExecuteAfter(8)@236 depositFeeBps(2)@244
///         withdrawalFeeBps(2)@246 totalBtcHeld(8)@248 utxoCount(2)@256
///         activeTreeIndex(4)@258 reserved(6)@262
pub mod pool_offsets {
    pub const AUTHORITY: usize = 4;
    pub const ZKBTC_MINT: usize = 36;
    pub const DEPOSIT_COUNT: usize = 132;
    pub const TOTAL_MINTED: usize = 140;
    pub const TOTAL_SHIELDED: usize = 188;
    pub const MIN_DEPOSIT: usize = 172;
    pub const MAX_DEPOSIT: usize = 180;
    pub const SERVICE_FEE_BASE: usize = 196;
    pub const FEE_POOL: usize = 204;
    pub const DEPOSIT_FEE_BPS: usize = 244;
    pub const WITHDRAWAL_FEE_BPS: usize = 246;
    pub const ACTIVE_TREE_INDEX: usize = 258;
}

// =============================================================================
// Default Fees (native smallest units per token)
// =============================================================================

pub const DEFAULT_RELAYER_FEE_BTC: u64 = 500;        // 0.000005 BTC
pub const DEFAULT_RELAYER_FEE_SOL: u64 = 100_000;    // 0.0001 SOL
pub const DEFAULT_RELAYER_FEE_USDC: u64 = 5_000;     // 0.005 USDC (6 dec)
pub const DEFAULT_RELAYER_FEE_USDT: u64 = 5_000;     // 0.005 USDT (6 dec)
pub const DEFAULT_RELAYER_FEE_JUPUSD: u64 = 5_000_000; // 0.005 jupUSD (9 dec)

// =============================================================================
// Bitcoin Constants
// =============================================================================

/// Minimum output value to avoid dust (satoshis)
pub const BTC_DUST_THRESHOLD: u64 = 330;

/// Basis points denominator
pub const BPS_DENOMINATOR: u64 = 10_000;
