/// Discriminator for BitcoinLightClient account
pub(crate) const BTC_LIGHT_CLIENT_DISCRIMINATOR: u8 = 0x06;

/// Discriminator for BlockHeader account
pub(crate) const BLOCK_HEADER_DISCRIMINATOR: u8 = 0x07;

/// Discriminator for VerifiedTransaction account
pub(crate) const VERIFIED_TX_DISCRIMINATOR: u8 = 0x08;

pub(crate) const LIGHT_CLIENT_SEED: &[u8] = b"btc_light_client";
pub(crate) const BLOCK_HEADER_SEED: &[u8] = b"block_header";
pub(crate) const VERIFIED_TX_SEED: &[u8] = b"verified_tx";

/// Target timespan for difficulty adjustment (2 weeks in seconds)
pub(crate) const TARGET_TIMESPAN: u32 = 1_209_600;

/// Blocks per difficulty epoch
pub(crate) const BLOCKS_PER_EPOCH: u64 = 2016;

/// Required confirmations for SPV verification
pub(crate) const REQUIRED_CONFIRMATIONS: u64 = 6;
