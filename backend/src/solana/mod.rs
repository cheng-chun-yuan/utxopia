//! Solana Infrastructure Module
//!
//! This module provides Solana blockchain interaction for the zVault backend:
//! - RPC client for Solana devnet/mainnet
//! - Transaction building and submission
//! - SPV proof verification on-chain

pub mod client;

// Re-exports for convenience
pub use client::{
    generate_keypair, load_keypair_from_file, SolClient, SolConfig, SolError, SpvMerkleProof,
    ATA_PROGRAM_ID, COMMITMENT_TREE, DEVNET_COMMITMENT_TREE, DEVNET_POOL_STATE, DEVNET_PROGRAM_ID,
    DEVNET_RPC, DEVNET_ZBTC_MINT, POOL_STATE, PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ZBTC_MINT,
};
