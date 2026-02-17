//! FROST Threshold Signing Server for zVault
//!
//! This library provides threshold Schnorr signatures using FROST
//! (Flexible Round-Optimized Schnorr Threshold signatures) for
//! secure Bitcoin operations in zVault.
//!
//! # Architecture
//!
//! - 3 signer nodes (2-of-3 threshold)
//! - Backend coordinates signing via HTTP
//! - Key shares generated via DKG (no trusted dealer)
//!
//! # Usage
//!
//! ## Start a signer
//! ```bash
//! frost-server run --config config/signer1.toml
//! ```
//!
//! ## Run DKG ceremony
//! ```bash
//! frost-server dkg --threshold 2 --total 3 \
//!     --signers http://localhost:9001,http://localhost:9002,http://localhost:9003
//! ```

pub mod dkg;
pub mod keystore;
pub mod server;
pub mod signing;
pub mod types;

pub use dkg::{DkgError, DkgParticipant};
pub use keystore::{Keystore, KeystoreError};
pub use server::{create_router, AppState};
pub use signing::{aggregate_signatures, FrostSigner, SigningError};
pub use types::*;
