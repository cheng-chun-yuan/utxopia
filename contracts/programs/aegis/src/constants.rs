//! Program constants

/// Minimum deposit amount in satoshis (0.00005 BTC)
pub const MIN_DEPOSIT_SATS: u64 = 5_000;

/// Maximum deposit amount in satoshis (1000 BTC)
pub const MAX_DEPOSIT_SATS: u64 = 100_000_000_000;

/// Required Bitcoin confirmations
pub const REQUIRED_CONFIRMATIONS: u32 = 2;

/// Maximum Groth16 proof size in bytes (256 bytes = 2 G1 + 1 G2)
pub const MAX_GROTH16_PROOF_SIZE: usize = 256;

/// Maximum BTC scriptPubKey length (raw bytes, not bech32 string)
/// P2TR/P2WSH = 34 bytes (OP_x + PUSH32 + 32-byte key/hash)
pub const MAX_BTC_SCRIPT_LEN: usize = 34;

/// BTC Light Client program ID — localnet (EU5ZyFqRuUHHJcarRWPmKxezhsFKBVjcc5M2L3sobmd7)
/// Generated from target/deploy/btc_light_client-keypair.json
#[cfg(feature = "localnet")]
pub const BTC_LIGHT_CLIENT_PROGRAM_ID: [u8; 32] = [
    0xc8, 0x17, 0xc7, 0x06, 0xc6, 0x45, 0xd7, 0x5a,
    0x2e, 0x89, 0xc7, 0x89, 0xe2, 0xd9, 0x25, 0xdf,
    0xd4, 0x8d, 0x51, 0xc7, 0x11, 0x01, 0x99, 0x20,
    0xfb, 0xd9, 0x0c, 0xb6, 0x49, 0xba, 0xaa, 0xce,
];

/// BTC Relay program ID — devnet (Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq)
#[cfg(not(feature = "localnet"))]
pub const BTC_LIGHT_CLIENT_PROGRAM_ID: [u8; 32] = [
    0xf9, 0x89, 0xe5, 0x99, 0x89, 0xcc, 0x7e, 0xc1,
    0xa0, 0x54, 0xb3, 0x8a, 0x3f, 0xa4, 0x56, 0x44,
    0x9a, 0x2e, 0x83, 0xd2, 0xbe, 0xf4, 0x78, 0x48,
    0x02, 0x46, 0xb5, 0x87, 0x45, 0xea, 0x9d, 0xb0,
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
