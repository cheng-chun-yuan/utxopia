//! Program constants

/// Minimum deposit amount in satoshis (0.0001 BTC)
pub const MIN_DEPOSIT_SATS: u64 = 10_000;

/// Maximum deposit amount in satoshis (1000 BTC)
pub const MAX_DEPOSIT_SATS: u64 = 100_000_000_000;

/// Maximum stakeable amount in yield pool (100 BTC = 10B sats)
/// This prevents overflow in yield calculations:
/// max_principal * max_epochs * max_rate < u64::MAX
/// 10_000_000_000 * 100_000 * 10_000 = 10^19 < 1.8*10^19 (u64::MAX)
pub const MAX_POOL_PRINCIPAL: u64 = 10_000_000_000;

/// Maximum epochs for yield calculation (prevents overflow)
pub const MAX_YIELD_EPOCHS: u64 = 100_000;

/// Required Bitcoin confirmations
pub const REQUIRED_CONFIRMATIONS: u32 = 2;

/// Maximum Groth16 proof size in bytes (256 bytes = 2 G1 + 1 G2)
pub const MAX_GROTH16_PROOF_SIZE: usize = 256;

/// Maximum BTC address length (bech32m)
pub const MAX_BTC_ADDRESS_LEN: usize = 62;

/// Maximum Bitcoin txid length (hex string)
pub const MAX_BTC_TXID_LEN: usize = 64;

/// Token-2022 program ID (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)
pub const TOKEN_2022_PROGRAM_ID: [u8; 32] = [
    0x06, 0xdd, 0xf6, 0xe1, 0xee, 0x75, 0x8f, 0xde,
    0x18, 0x42, 0x5d, 0xbc, 0xe4, 0x6c, 0xcd, 0xda,
    0xb6, 0x1a, 0xfc, 0x4d, 0x83, 0xb9, 0x0d, 0x27,
    0xfe, 0xbd, 0xf9, 0x28, 0xd8, 0xa1, 0x8b, 0xfc,
];
