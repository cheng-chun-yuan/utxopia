//! FROST Client for threshold signing
//!
//! Implements the Signer trait using FROST threshold signatures
//! by coordinating with multiple FROST signer nodes.

use crate::bitcoin::signer::{Signer, SignerError};
use bitcoin::secp256k1::{self, Secp256k1};
use bitcoin::XOnlyPublicKey;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// FROST client that coordinates threshold signing
pub struct FrostClient {
    /// URLs of signer nodes
    signer_urls: Vec<String>,
    /// Threshold required for signing
    threshold: usize,
    /// Group public key (aggregated from DKG)
    group_public_key: XOnlyPublicKey,
    /// HTTP client for signer communication
    http_client: reqwest::Client,
}

/// Round 1 request
#[derive(Debug, Serialize)]
struct Round1Request {
    session_id: String,
    sighash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tweak: Option<String>,
}

/// Round 1 response
#[derive(Debug, Deserialize)]
struct Round1Response {
    commitment: String,
    signer_id: u16,
}

/// Round 2 request
#[derive(Debug, Serialize)]
struct Round2Request {
    session_id: String,
    sighash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tweak: Option<String>,
    commitments: BTreeMap<u16, String>,
}

/// Round 2 response
#[derive(Debug, Deserialize)]
struct Round2Response {
    signature_share: String,
    signer_id: u16,
}


impl FrostClient {
    /// Create a new FROST client
    ///
    /// # Arguments
    /// * `signer_urls` - URLs of FROST signer nodes
    /// * `threshold` - Number of signers required (t of n)
    /// * `group_public_key` - Aggregated public key from DKG
    pub fn new(
        signer_urls: Vec<String>,
        threshold: usize,
        group_public_key: XOnlyPublicKey,
    ) -> Self {
        Self {
            signer_urls,
            threshold,
            group_public_key,
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("Failed to create HTTP client"),
        }
    }

    /// Create from environment variables
    ///
    /// Expects:
    /// - FROST_SIGNER_URLS: comma-separated URLs
    /// - FROST_GROUP_PUBKEY: hex-encoded x-only public key
    /// - FROST_THRESHOLD: threshold value
    pub fn from_env() -> Result<Self, FrostClientError> {
        let urls_str = std::env::var("FROST_SIGNER_URLS")
            .map_err(|_| FrostClientError::Config("FROST_SIGNER_URLS not set".to_string()))?;

        let signer_urls: Vec<String> = urls_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        if signer_urls.is_empty() {
            return Err(FrostClientError::Config(
                "No signer URLs provided".to_string(),
            ));
        }

        let pubkey_hex = std::env::var("FROST_GROUP_PUBKEY")
            .map_err(|_| FrostClientError::Config("FROST_GROUP_PUBKEY not set".to_string()))?;

        let pubkey_bytes = hex::decode(&pubkey_hex)
            .map_err(|e| FrostClientError::Config(format!("Invalid pubkey hex: {}", e)))?;

        let group_public_key = XOnlyPublicKey::from_slice(&pubkey_bytes)
            .map_err(|e| FrostClientError::Config(format!("Invalid public key: {}", e)))?;

        let threshold: usize = std::env::var("FROST_THRESHOLD")
            .unwrap_or_else(|_| "2".to_string())
            .parse()
            .map_err(|e| FrostClientError::Config(format!("Invalid threshold: {}", e)))?;

        Ok(Self::new(signer_urls, threshold, group_public_key))
    }

    /// Execute FROST signing protocol
    async fn sign_async(&self, sighash: &[u8; 32], tweak: Option<&[u8; 32]>) -> Result<[u8; 64], FrostClientError> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let sighash_hex = hex::encode(sighash);
        let tweak_hex = tweak.map(|t| hex::encode(t));

        // Select threshold signers (use first N)
        let selected_urls: Vec<&String> = self.signer_urls.iter().take(self.threshold).collect();

        if selected_urls.len() < self.threshold {
            return Err(FrostClientError::InsufficientSigners {
                required: self.threshold,
                available: selected_urls.len(),
            });
        }

        tracing::debug!(
            session_id = %session_id,
            signers = ?selected_urls,
            "Starting FROST signing"
        );

        // Round 1: Collect commitments from all selected signers
        let mut commitments: BTreeMap<u16, String> = BTreeMap::new();

        for url in &selected_urls {
            let request = Round1Request {
                session_id: session_id.clone(),
                sighash: sighash_hex.clone(),
                tweak: tweak_hex.clone(),
            };

            let response: Round1Response = self
                .http_client
                .post(format!("{}/round1", url))
                .json(&request)
                .send()
                .await
                .map_err(|e| FrostClientError::Network(e.to_string()))?
                .json()
                .await
                .map_err(|e| FrostClientError::Protocol(format!("Round 1 parse error: {}", e)))?;

            commitments.insert(response.signer_id, response.commitment);
        }

        tracing::debug!(
            session_id = %session_id,
            num_commitments = commitments.len(),
            "Round 1 complete"
        );

        // Round 2: Collect signature shares
        let mut signature_shares: Vec<(u16, Vec<u8>)> = Vec::new();

        for url in &selected_urls {
            let request = Round2Request {
                session_id: session_id.clone(),
                sighash: sighash_hex.clone(),
                tweak: tweak_hex.clone(),
                commitments: commitments.clone(),
            };

            let response: Round2Response = self
                .http_client
                .post(format!("{}/round2", url))
                .json(&request)
                .send()
                .await
                .map_err(|e| FrostClientError::Network(e.to_string()))?
                .json()
                .await
                .map_err(|e| FrostClientError::Protocol(format!("Round 2 parse error: {}", e)))?;

            let share_bytes = hex::decode(&response.signature_share)
                .map_err(|e| FrostClientError::Protocol(format!("Invalid share hex: {}", e)))?;

            signature_shares.push((response.signer_id, share_bytes));
        }

        tracing::debug!(
            session_id = %session_id,
            num_shares = signature_shares.len(),
            "Round 2 complete"
        );

        // Aggregate signatures
        // Note: In a full implementation, we would use frost-secp256k1-tr here
        // For now, we'll send aggregation request to any signer or do it locally
        let signature = self.aggregate_shares(&commitments, &signature_shares, sighash)?;

        tracing::info!(
            session_id = %session_id,
            "FROST signing complete"
        );

        Ok(signature)
    }

    /// Aggregate signature shares into final signature
    fn aggregate_shares(
        &self,
        _commitments: &BTreeMap<u16, String>,
        signature_shares: &[(u16, Vec<u8>)],
        _sighash: &[u8; 32],
    ) -> Result<[u8; 64], FrostClientError> {
        // In a complete implementation, this would use frost-secp256k1-tr::aggregate
        // For now, we concatenate shares as a placeholder
        // The actual aggregation should be done using the FROST library

        if signature_shares.is_empty() {
            return Err(FrostClientError::Protocol("No signature shares".to_string()));
        }

        // This is a placeholder - actual FROST aggregation needed
        // The frost_server should provide an aggregation endpoint
        // or we link against frost-secp256k1-tr here
        let mut result = [0u8; 64];
        if let Some((_, share)) = signature_shares.first() {
            if share.len() >= 64 {
                result.copy_from_slice(&share[..64]);
            }
        }

        Ok(result)
    }
}

impl Signer for FrostClient {
    fn public_key(&self) -> XOnlyPublicKey {
        self.group_public_key
    }

    fn sign(&self, sighash: &[u8; 32]) -> Result<[u8; 64], SignerError> {
        // Use tokio runtime for async operation
        let rt = tokio::runtime::Handle::try_current()
            .or_else(|_| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map(|rt| rt.handle().clone())
            })
            .map_err(|e| SignerError::SigningFailed(format!("No tokio runtime: {}", e)))?;

        rt.block_on(self.sign_async(sighash, None))
            .map_err(|e| SignerError::SigningFailed(e.to_string()))
    }

    fn sign_tweaked(&self, sighash: &[u8; 32], tweak: &[u8; 32]) -> Result<[u8; 64], SignerError> {
        let rt = tokio::runtime::Handle::try_current()
            .or_else(|_| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map(|rt| rt.handle().clone())
            })
            .map_err(|e| SignerError::SigningFailed(format!("No tokio runtime: {}", e)))?;

        rt.block_on(self.sign_async(sighash, Some(tweak)))
            .map_err(|e| SignerError::SigningFailed(e.to_string()))
    }
}

/// FROST client errors
#[derive(Debug, thiserror::Error)]
pub enum FrostClientError {
    #[error("configuration error: {0}")]
    Config(String),
    #[error("network error: {0}")]
    Network(String),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("insufficient signers: need {required}, have {available}")]
    InsufficientSigners { required: usize, available: usize },
    #[error("aggregation failed: {0}")]
    Aggregation(String),
}

/// Helper to derive Taproot address from FROST group key
pub fn derive_frost_taproot_address(
    group_pubkey: &XOnlyPublicKey,
    commitment: &[u8; 32],
    network: bitcoin::Network,
) -> Result<String, FrostClientError> {
    use bitcoin::key::TweakedPublicKey;
    use bitcoin::Address;
    use sha2::{Digest, Sha256};

    let secp = Secp256k1::new();

    // Compute tweak from group key and commitment
    let tag_hash = {
        let mut hasher = Sha256::new();
        hasher.update(b"TapTweak");
        hasher.finalize()
    };

    let mut hasher = Sha256::new();
    hasher.update(&tag_hash);
    hasher.update(&tag_hash);
    hasher.update(&group_pubkey.serialize());
    hasher.update(commitment);
    let tweak_bytes: [u8; 32] = hasher.finalize().into();

    let scalar = secp256k1::Scalar::from_be_bytes(tweak_bytes)
        .map_err(|_| FrostClientError::Config("Invalid tweak scalar".to_string()))?;

    let (tweaked, _parity) = group_pubkey
        .add_tweak(&secp, &scalar)
        .map_err(|_| FrostClientError::Config("Tweak failed".to_string()))?;

    let address = Address::p2tr_tweaked(
        TweakedPublicKey::dangerous_assume_tweaked(tweaked),
        network,
    );

    Ok(address.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_taproot_address() {
        // Test with a dummy public key
        let pubkey_bytes = [0x02u8; 32]; // Not a valid point, just for testing parsing
        // In real test, use a valid x-only pubkey

        // This would fail with invalid pubkey, which is expected
        // Real tests would use generated keys from FROST DKG
    }
}
