//! Program constants

/// Minimum deposit amount in satoshis (0.0001 BTC)
pub const MIN_DEPOSIT_SATS: u64 = 10_000;

/// Maximum deposit amount in satoshis (1000 BTC)
pub const MAX_DEPOSIT_SATS: u64 = 100_000_000_000;

/// Required Bitcoin confirmations
pub const REQUIRED_CONFIRMATIONS: u32 = 2;

/// Maximum Groth16 proof size in bytes (256 bytes = 2 G1 + 1 G2)
pub const MAX_GROTH16_PROOF_SIZE: usize = 256;

/// Maximum BTC address length (bech32m)
pub const MAX_BTC_ADDRESS_LEN: usize = 62;

/// BTC Relay program ID — localnet override (DeDut4fkjbWBPY4FRUU3q9BUcvwTisHczj1EQmqX5avS)
#[cfg(feature = "localnet")]
pub const BTC_LIGHT_CLIENT_PROGRAM_ID: [u8; 32] = [
    0xbb, 0xd5, 0x55, 0x17, 0xb2, 0x8a, 0xc8, 0xd3,
    0x07, 0xd9, 0x0b, 0xfe, 0x03, 0xbc, 0x51, 0x45,
    0x4f, 0x88, 0x22, 0xe4, 0xa7, 0xb2, 0xdd, 0x09,
    0x78, 0x3a, 0xf7, 0x38, 0x86, 0xbb, 0x0d, 0xbf,
];

/// BTC Relay program ID — devnet (DeDut4fkjbWBPY4FRUU3q9BUcvwTisHczj1EQmqX5avS)
#[cfg(not(feature = "localnet"))]
pub const BTC_LIGHT_CLIENT_PROGRAM_ID: [u8; 32] = [
    0xbb, 0xd5, 0x55, 0x17, 0xb2, 0x8a, 0xc8, 0xd3,
    0x07, 0xd9, 0x0b, 0xfe, 0x03, 0xbc, 0x51, 0x45,
    0x4f, 0x88, 0x22, 0xe4, 0xa7, 0xb2, 0xdd, 0x09,
    0x78, 0x3a, 0xf7, 0x38, 0x86, 0xbb, 0x0d, 0xbf,
];

/// Maximum safe JoinSplit size (N + M).
/// Larger variants exceed Solana's 1232-byte transaction limit.
pub const MAX_SAFE_JOINSPLIT_SIZE: usize = 10;

/// Chain ID for bound params hash verification (prevents cross-chain replay).
#[cfg(not(feature = "mainnet"))]
pub const CHAIN_ID: u64 = 103; // Solana devnet

#[cfg(feature = "mainnet")]
pub const CHAIN_ID: u64 = 101; // Solana mainnet

/// Redemption processing timeout in slots (~1 hour at ~2.5 slots/sec).
/// If a redemption stays in Processing longer than this, the user can cancel.
pub const REDEMPTION_TIMEOUT_SLOTS: u64 = 9000;

/// Token-2022 program ID (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)
pub const TOKEN_2022_PROGRAM_ID: [u8; 32] = [
    0x06, 0xdd, 0xf6, 0xe1, 0xee, 0x75, 0x8f, 0xde,
    0x18, 0x42, 0x5d, 0xbc, 0xe4, 0x6c, 0xcd, 0xda,
    0xb6, 0x1a, 0xfc, 0x4d, 0x83, 0xb9, 0x0d, 0x27,
    0xfe, 0xbd, 0xf9, 0x28, 0xd8, 0xa1, 0x8b, 0xfc,
];
