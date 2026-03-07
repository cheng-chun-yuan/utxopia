//! Solana Infrastructure Module
//!
//! This module provides Solana blockchain interaction for the Aegis backend:
//! - RPC client for Solana devnet/mainnet
//! - Transaction building and submission
//! - SPV proof verification on-chain

pub mod client;

// Re-exports for convenience
pub use client::{
    generate_keypair, load_keypair_from_file, SolClient, SolConfig, SolError, SpvMerkleProof,
    ATA_PROGRAM_ID, DEVNET_COMMITMENT_TREE, DEVNET_POOL_STATE, DEVNET_PROGRAM_ID,
    DEVNET_RPC, DEVNET_ZKBTC_MINT, TOKEN_2022_PROGRAM_ID,
};
