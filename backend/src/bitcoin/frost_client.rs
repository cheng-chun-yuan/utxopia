//! FROST Threshold Signing HTTP Client
//!
//! Shared client for communicating with FROST signer servers.
//! Used by both `MpcSigner` (redemption) and `UtxoSweeper` (deposit sweeping).
//!
//! ## Retry Strategy
//!
//! - **Round 1**: Try all N signers concurrently, use first T that respond.
//!   Failed signers retried once with 1s backoff.
//! - **Round 2**: Only contact the T signers that participated in round 1.
//! - **Aggregate**: Retry up to 2x with 500ms backoff.
//! - **Session retry**: If round 2 fails with SESSION_NOT_FOUND, restart
//!   the entire flow from round 1 (max 2 full retries).

use bitcoin::secp256k1::{self, Secp256k1};
use bitcoin::XOnlyPublicKey;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;
use thiserror::Error;
use tracing;

/// Errors from FROST client operations
#[derive(Debug, Error)]
pub enum FrostError {
    #[error("HTTP request failed: {0}")]
    HttpError(String),

    #[error("FROST signing failed: {0}")]
    SigningFailed(String),

    #[error("not enough signers responded: got {got}, need {need}")]
    InsufficientSigners { got: usize, need: usize },

    #[error("invalid signature length: expected 64 bytes, got {0}")]
    InvalidSignatureLength(usize),

    #[error("broadcast channel verification failed: commitment digest mismatch")]
    DigestMismatch { digests: BTreeMap<u16, String> },

    #[error("session not found on signer (stale session)")]
    SessionNotFound,

    #[error("max retries exceeded after {0} attempts")]
    MaxRetriesExceeded(usize),
}

// ─── FROST API Types (mirrored from frost_server/src/types.rs) ───

/// Transaction context for signer-side verification
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SigningContext {
    /// Raw unsigned transaction (bitcoin consensus-encoded, hex)
    pub raw_tx_hex: String,
    /// Previous outputs being spent
    pub prevouts: Vec<PrevoutInfo>,
    /// Which input index this sighash is for
    pub input_index: u32,
}

/// Information about a previous output being spent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrevoutInfo {
    /// UTXO txid (hex)
    pub txid: String,
    /// UTXO output index
    pub vout: u32,
    /// Amount in satoshis
    pub amount_sats: u64,
    /// Script pubkey (hex)
    pub script_pubkey_hex: String,
}

/// Solana on-chain verification data for FROST signers
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SolanaVerification {
    /// Verify a RedemptionRequest PDA exists on-chain
    Withdrawal {
        /// Requester's Solana pubkey (base58)
        requester: String,
        /// Redemption request nonce
        nonce: u64,
        /// Expected withdrawal amount in satoshis (gross — matches PDA)
        expected_amount_sats: u64,
        /// Expected BTC send amount in satoshis (net — matches tx output)
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_send_amount: Option<u64>,
        /// Expected BTC destination address
        expected_btc_address: String,
        /// UTXO inputs: (txid_hex, vout, amount_sats) — verified against on-chain Reserved UtxoRecord PDAs
        #[serde(default)]
        utxo_inputs: Vec<(String, u32, u64)>,
    },
    /// Verify a DepositIntent PDA exists for sweep signing
    Sweep {
        /// Note public key (hex, 32 bytes) — used to derive PDA
        npk: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round1Request {
    pub session_id: String,
    pub sighash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tweak: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signing_context: Option<SigningContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merkle_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solana_verification: Option<SolanaVerification>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round1Response {
    pub commitment: String,
    pub signer_id: u16,
    pub frost_identifier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round2Request {
    pub session_id: String,
    pub sighash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tweak: Option<String>,
    pub commitments: BTreeMap<u16, String>,
    #[serde(default)]
    pub identifier_map: BTreeMap<u16, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merkle_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round2Response {
    pub signature_share: String,
    pub signer_id: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregateRequest {
    pub commitments: BTreeMap<u16, String>,
    pub identifier_map: BTreeMap<u16, String>,
    pub signature_shares: BTreeMap<u16, String>,
    pub sighash: String,
    /// Optional Taproot merkle root for BIP-341 tweaked aggregation (hex).
    /// Used when sweeping commitment-tweaked deposit addresses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merkle_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregateResponse {
    pub signature: String,
    pub group_public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyCommitmentsRequest {
    pub session_id: String,
    pub commitments: BTreeMap<u16, String>,
    #[serde(default)]
    pub identifier_map: BTreeMap<u16, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyCommitmentsResponse {
    pub signer_id: u16,
    pub digest: String,
}

// ─── FROST Client ───

/// HTTP client for FROST threshold signing servers
#[derive(Clone)]
pub struct FrostClient {
    http: Client,
    /// URLs of FROST signer servers (e.g., ["http://localhost:4001", ...])
    signer_urls: Vec<String>,
    /// Number of signers required (threshold)
    threshold: usize,
    /// Optional API key for authentication
    api_key: Option<String>,
}

/// Tracks which signers participated in round 1 (for round 2 targeting)
struct Round1Result {
    /// URLs of the signers that successfully completed round 1
    participating_urls: Vec<String>,
    commitments: BTreeMap<u16, String>,
    identifier_map: BTreeMap<u16, String>,
}

impl FrostClient {
    /// Create a new FROST client
    ///
    /// # Arguments
    /// * `signer_urls` - URLs of all FROST signer servers
    /// * `threshold` - Minimum number of signers required
    /// * `api_key` - Optional API key for FROST server auth
    pub fn new(signer_urls: Vec<String>, threshold: usize, api_key: Option<String>) -> Self {
        Self {
            http: crate::common::http::http_client_with_timeout(Duration::from_secs(30)),
            signer_urls,
            threshold,
            api_key,
        }
    }

    /// Sign a sighash using the FROST threshold signing protocol.
    ///
    /// Returns the 64-byte Schnorr signature.
    ///
    /// If `signing_context` is provided, it is sent to each signer so they can
    /// independently verify the transaction before signing.
    ///
    /// If `solana_verification` is provided, each signer independently verifies
    /// the corresponding Solana on-chain state before signing.
    ///
    /// Implements session-level retry: if round 2 fails with SESSION_NOT_FOUND,
    /// restarts the entire flow from round 1 (max 2 full retries).
    pub async fn sign_sighash(
        &self,
        sighash: &[u8; 32],
        tweak: Option<&[u8; 32]>,
        signing_context: Option<SigningContext>,
        solana_verification: Option<SolanaVerification>,
    ) -> Result<[u8; 64], FrostError> {
        self.sign_sighash_tweaked(sighash, tweak, signing_context, None, solana_verification).await
    }

    /// Sign a sighash with optional BIP-341 Taproot merkle root for tweaked aggregation.
    ///
    /// When `merkle_root` is provided, the FROST aggregate step applies the BIP-341 tweak
    /// so the signature verifies against the tweaked output key (used for commitment-tweaked
    /// deposit addresses).
    pub async fn sign_sighash_tweaked(
        &self,
        sighash: &[u8; 32],
        tweak: Option<&[u8; 32]>,
        signing_context: Option<SigningContext>,
        merkle_root: Option<&[u8]>,
        solana_verification: Option<SolanaVerification>,
    ) -> Result<[u8; 64], FrostError> {
        let sighash_hex = hex::encode(sighash);
        let tweak_hex = tweak.map(hex::encode);
        let merkle_root_hex = merkle_root.map(hex::encode);

        if self.signer_urls.len() < self.threshold {
            return Err(FrostError::InsufficientSigners {
                got: self.signer_urls.len(),
                need: self.threshold,
            });
        }

        let max_session_retries = 2;
        let mut last_error = None;

        for attempt in 0..=max_session_retries {
            if attempt > 0 {
                tracing::warn!(attempt, "retrying entire signing session from round 1");
            }

            match self
                .sign_sighash_inner(&sighash_hex, &tweak_hex, &signing_context, &merkle_root_hex, &solana_verification)
                .await
            {
                Ok(sig) => return Ok(sig),
                Err(FrostError::SessionNotFound) if attempt < max_session_retries => {
                    tracing::warn!("session not found, will restart from round 1");
                    last_error = Some(FrostError::SessionNotFound);
                    continue;
                }
                Err(e) => return Err(e),
            }
        }

        Err(last_error.unwrap_or(FrostError::MaxRetriesExceeded(max_session_retries)))
    }

    /// Inner signing flow for a single session attempt
    async fn sign_sighash_inner(
        &self,
        sighash_hex: &str,
        tweak_hex: &Option<String>,
        signing_context: &Option<SigningContext>,
        merkle_root_hex: &Option<String>,
        solana_verification: &Option<SolanaVerification>,
    ) -> Result<[u8; 64], FrostError> {
        let session_id = uuid::Uuid::new_v4().to_string();

        // ── Round 1: Collect commitments from signers ──
        // Try ALL N signers, use first T that respond. Retry failed signers once.
        let round1 = self
            .round1_with_retry(&session_id, sighash_hex, tweak_hex, signing_context, merkle_root_hex, solana_verification)
            .await?;

        // ── Broadcast Verification ──
        self.verify_broadcast(&session_id, &round1).await?;

        // ── Round 2: Collect signature shares (only from round 1 participants) ──
        let signature_shares = self
            .round2_targeted(&session_id, sighash_hex, tweak_hex, &round1, merkle_root_hex)
            .await?;

        // ── Aggregate with retry ──
        self.aggregate_with_retry(&round1, &signature_shares, sighash_hex, merkle_root_hex)
            .await
    }

    /// Build a Round1Request from shared parameters
    fn build_round1_request(
        session_id: &str,
        sighash_hex: &str,
        tweak_hex: &Option<String>,
        signing_context: &Option<SigningContext>,
        merkle_root_hex: &Option<String>,
        solana_verification: &Option<SolanaVerification>,
    ) -> Round1Request {
        Round1Request {
            session_id: session_id.to_string(),
            sighash: sighash_hex.to_string(),
            tweak: tweak_hex.clone(),
            signing_context: signing_context.clone(),
            merkle_root: merkle_root_hex.clone(),
            solana_verification: solana_verification.clone(),
        }
    }

    /// Send round1 request to a signer URL, collecting results into accumulators
    async fn try_round1_signer(
        &self,
        url: &str,
        request: &Round1Request,
        commitments: &mut BTreeMap<u16, String>,
        identifier_map: &mut BTreeMap<u16, String>,
        participating_urls: &mut Vec<String>,
    ) -> Result<(), FrostError> {
        let response: Round1Response = self.post(url, "/round1", request).await?;
        commitments.insert(response.signer_id, response.commitment);
        identifier_map.insert(response.signer_id, response.frost_identifier);
        participating_urls.push(url.to_string());
        Ok(())
    }

    /// Round 1 with retry: try all N signers, retry failures once with 1s backoff
    async fn round1_with_retry(
        &self,
        session_id: &str,
        sighash_hex: &str,
        tweak_hex: &Option<String>,
        signing_context: &Option<SigningContext>,
        merkle_root_hex: &Option<String>,
        solana_verification: &Option<SolanaVerification>,
    ) -> Result<Round1Result, FrostError> {
        let mut commitments: BTreeMap<u16, String> = BTreeMap::new();
        let mut identifier_map: BTreeMap<u16, String> = BTreeMap::new();
        let mut participating_urls: Vec<String> = Vec::new();
        let mut failed_urls: Vec<String> = Vec::new();

        let request = Self::build_round1_request(
            session_id, sighash_hex, tweak_hex, signing_context, merkle_root_hex, solana_verification,
        );

        // First pass: try all signers
        for url in &self.signer_urls {
            match self.try_round1_signer(url, &request, &mut commitments, &mut identifier_map, &mut participating_urls).await {
                Ok(()) => {
                    tracing::debug!(url, "round 1 OK");
                }
                Err(e) => {
                    tracing::warn!(url, error = %e, "round 1 failed, will retry");
                    failed_urls.push(url.clone());
                }
            }

            // Stop early once we have enough
            if commitments.len() >= self.threshold {
                break;
            }
        }

        // Retry failed signers once (with 1s backoff) if we still need more
        if commitments.len() < self.threshold && !failed_urls.is_empty() {
            tokio::time::sleep(Duration::from_secs(1)).await;

            for url in &failed_urls {
                if commitments.len() >= self.threshold {
                    break;
                }

                match self.try_round1_signer(url, &request, &mut commitments, &mut identifier_map, &mut participating_urls).await {
                    Ok(()) => {
                        tracing::info!(url, "round 1 retry OK");
                    }
                    Err(e) => {
                        tracing::warn!(url, error = %e, "round 1 retry also failed");
                    }
                }
            }
        }

        if commitments.len() < self.threshold {
            return Err(FrostError::InsufficientSigners {
                got: commitments.len(),
                need: self.threshold,
            });
        }

        Ok(Round1Result {
            participating_urls,
            commitments,
            identifier_map,
        })
    }

    /// Broadcast verification: verify all signers see the same commitments
    async fn verify_broadcast(
        &self,
        session_id: &str,
        round1: &Round1Result,
    ) -> Result<(), FrostError> {
        let mut digests: BTreeMap<u16, String> = BTreeMap::new();

        for url in round1.participating_urls.iter().take(self.threshold) {
            let request = VerifyCommitmentsRequest {
                session_id: session_id.to_string(),
                commitments: round1.commitments.clone(),
                identifier_map: round1.identifier_map.clone(),
            };

            let response: VerifyCommitmentsResponse = self
                .post(url, "/verify-commitments", &request)
                .await?;

            digests.insert(response.signer_id, response.digest);
        }

        let digest_values: Vec<&String> = digests.values().collect();
        if digest_values.windows(2).any(|w| w[0] != w[1]) {
            return Err(FrostError::DigestMismatch { digests });
        }

        Ok(())
    }

    /// Round 2: only contact the T signers that participated in round 1
    async fn round2_targeted(
        &self,
        session_id: &str,
        sighash_hex: &str,
        tweak_hex: &Option<String>,
        round1: &Round1Result,
        merkle_root_hex: &Option<String>,
    ) -> Result<BTreeMap<u16, String>, FrostError> {
        let mut signature_shares: BTreeMap<u16, String> = BTreeMap::new();

        for url in round1.participating_urls.iter().take(self.threshold) {
            let request = Round2Request {
                session_id: session_id.to_string(),
                sighash: sighash_hex.to_string(),
                tweak: tweak_hex.clone(),
                commitments: round1.commitments.clone(),
                identifier_map: round1.identifier_map.clone(),
                merkle_root: merkle_root_hex.clone(),
            };

            match self.post::<_, Round2Response>(url, "/round2", &request).await {
                Ok(response) => {
                    signature_shares.insert(response.signer_id, response.signature_share);
                }
                Err(FrostError::SigningFailed(ref msg)) if msg.contains("SESSION_NOT_FOUND") => {
                    tracing::warn!(url, "session not found on signer — triggering session retry");
                    return Err(FrostError::SessionNotFound);
                }
                Err(e) => return Err(e),
            }
        }

        Ok(signature_shares)
    }

    /// Aggregate with retry: up to 2 retries with 500ms backoff
    async fn aggregate_with_retry(
        &self,
        round1: &Round1Result,
        signature_shares: &BTreeMap<u16, String>,
        sighash_hex: &str,
        merkle_root_hex: &Option<String>,
    ) -> Result<[u8; 64], FrostError> {
        let aggregate_request = AggregateRequest {
            commitments: round1.commitments.clone(),
            identifier_map: round1.identifier_map.clone(),
            signature_shares: signature_shares.clone(),
            sighash: sighash_hex.to_string(),
            merkle_root: merkle_root_hex.clone(),
        };

        // Use the first participating signer for aggregation
        let agg_url = &round1.participating_urls[0];
        let max_retries = 2;

        for attempt in 0..=max_retries {
            match self
                .post::<_, AggregateResponse>(agg_url, "/aggregate", &aggregate_request)
                .await
            {
                Ok(response) => {
                    let sig_bytes = hex::decode(&response.signature).map_err(|e| {
                        FrostError::SigningFailed(format!("invalid signature hex: {}", e))
                    })?;

                    if sig_bytes.len() != 64 {
                        return Err(FrostError::InvalidSignatureLength(sig_bytes.len()));
                    }

                    let mut sig = [0u8; 64];
                    sig.copy_from_slice(&sig_bytes);
                    return Ok(sig);
                }
                Err(e) if attempt < max_retries => {
                    tracing::warn!(
                        attempt,
                        error = %e,
                        "aggregate failed, retrying in 500ms"
                    );
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err(e) => return Err(e),
            }
        }

        Err(FrostError::MaxRetriesExceeded(max_retries))
    }

    /// POST JSON to a FROST signer endpoint
    async fn post<Req: Serialize, Resp: for<'de> Deserialize<'de>>(
        &self,
        base_url: &str,
        path: &str,
        body: &Req,
    ) -> Result<Resp, FrostError> {
        let url = format!("{}{}", base_url, path);

        let mut request = self.http.post(&url).json(body);

        if let Some(ref key) = self.api_key {
            request = request.header("X-API-Key", key);
        }

        let response = request
            .send()
            .await
            .map_err(|e| FrostError::HttpError(format!("{}: {}", url, e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "no body".to_string());
            return Err(FrostError::SigningFailed(format!(
                "{} returned {}: {}",
                url, status, body
            )));
        }

        response
            .json()
            .await
            .map_err(|e| FrostError::SigningFailed(format!("failed to parse response from {}: {}", url, e)))
    }
}

/// Helper to derive Taproot address from FROST group key
pub fn derive_frost_taproot_address(
    group_pubkey: &XOnlyPublicKey,
    commitment: &[u8; 32],
    network: bitcoin::Network,
) -> Result<String, FrostError> {
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
        .map_err(|_| FrostError::SigningFailed("Invalid tweak scalar".to_string()))?;

    let (tweaked, _parity) = group_pubkey
        .add_tweak(&secp, &scalar)
        .map_err(|_| FrostError::SigningFailed("Tweak failed".to_string()))?;

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
    fn test_frost_client_creation() {
        let client = FrostClient::new(
            vec!["http://localhost:4001".to_string(), "http://localhost:4002".to_string()],
            2,
            Some("test-key".to_string()),
        );
        assert_eq!(client.signer_urls.len(), 2);
        assert_eq!(client.threshold, 2);
    }

    #[test]
    fn test_insufficient_urls() {
        let client = FrostClient::new(vec!["http://localhost:4001".to_string()], 2, None);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(client.sign_sighash(&[0u8; 32], None, None, None));
        assert!(matches!(result, Err(FrostError::InsufficientSigners { .. })));
    }

    #[test]
    fn test_build_round1_request() {
        let session_id = "test-session";
        let sighash = "aa".repeat(32);
        let tweak = Some("bb".repeat(32));
        let request = FrostClient::build_round1_request(
            session_id, &sighash, &tweak, &None, &None, &None,
        );
        assert_eq!(request.session_id, "test-session");
        assert_eq!(request.sighash, sighash);
        assert_eq!(request.tweak, tweak);
        assert!(request.signing_context.is_none());
        assert!(request.merkle_root.is_none());
        assert!(request.solana_verification.is_none());
    }

    #[test]
    fn test_build_round1_request_with_context() {
        let ctx = SigningContext {
            raw_tx_hex: "0200000001".to_string(),
            prevouts: vec![],
            input_index: 0,
        };
        let request = FrostClient::build_round1_request(
            "s1", "ab".repeat(32).as_str(), &None, &Some(ctx.clone()), &None, &None,
        );
        assert!(request.signing_context.is_some());
        assert_eq!(request.signing_context.unwrap().raw_tx_hex, "0200000001");
    }

    #[tokio::test]
    async fn test_round1_with_retry_no_signers() {
        let client = FrostClient::new(vec![], 2, None);
        let result = client.round1_with_retry(
            "session-1", &"aa".repeat(32), &None, &None, &None, &None,
        ).await;
        assert!(matches!(result, Err(FrostError::InsufficientSigners { got: 0, need: 2 })));
    }

    #[tokio::test]
    async fn test_round1_with_retry_unreachable_signers() {
        // Signers at invalid URLs should fail gracefully and return InsufficientSigners
        let client = FrostClient::new(
            vec![
                "http://127.0.0.1:59999".to_string(),
                "http://127.0.0.1:59998".to_string(),
            ],
            2,
            None,
        );
        let result = client.round1_with_retry(
            "session-2", &"bb".repeat(32), &None, &None, &None, &None,
        ).await;
        assert!(matches!(result, Err(FrostError::InsufficientSigners { .. })));
    }

    #[test]
    fn test_frost_error_display() {
        let err = FrostError::InsufficientSigners { got: 1, need: 2 };
        assert!(err.to_string().contains("got 1"));
        assert!(err.to_string().contains("need 2"));

        let err = FrostError::InvalidSignatureLength(32);
        assert!(err.to_string().contains("32"));
    }
}
