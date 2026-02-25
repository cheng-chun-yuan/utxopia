//! Request and response types for FROST signer API

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

/// Signer information response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignerInfo {
    /// Unique signer identifier (1-indexed)
    pub signer_id: u16,
    /// Public key share (hex-encoded compressed point)
    pub public_key_share: String,
    /// Group public key (hex-encoded x-only 32 bytes)
    pub group_public_key: String,
    /// Threshold required for signing
    pub threshold: u16,
    /// Total number of participants
    pub total_participants: u16,
}

/// Transaction context for signer-side verification.
///
/// When present, each FROST signer independently recomputes the BIP-341 sighash
/// from this data and rejects if it doesn't match the claimed `sighash`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SigningContext {
    /// Raw unsigned transaction (bitcoin consensus-encoded, hex)
    pub raw_tx_hex: String,
    /// Previous outputs being spent
    pub prevouts: Vec<PrevoutInfo>,
    /// Which input index this sighash is for
    pub input_index: u32,
}

/// Information about a previous output (UTXO) being spent
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

/// Solana on-chain verification data.
///
/// When present in a signing request, each FROST signer independently queries
/// Solana RPC to verify that the corresponding on-chain state exists before signing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SolanaVerification {
    /// Verify a RedemptionRequest PDA exists with matching data
    Withdrawal {
        /// Requester's Solana pubkey (base58)
        requester: String,
        /// Redemption request nonce
        nonce: u64,
        /// Expected withdrawal amount in satoshis
        expected_amount_sats: u64,
        /// Expected BTC destination address
        expected_btc_address: String,
    },
}

/// Round 1 request - generate commitment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round1Request {
    /// Unique session identifier
    pub session_id: Uuid,
    /// Message hash to sign (hex-encoded 32 bytes)
    pub sighash: String,
    /// Optional tweak for Taproot key-path spending (hex-encoded 32 bytes)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tweak: Option<String>,
    /// Optional transaction context for signer-side verification.
    /// When present, policy checks are enforced. When absent, behavior
    /// depends on the signer's `require_context` setting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signing_context: Option<SigningContext>,
    /// Optional BIP-341 merkle root for Taproot tweaked signing (hex-encoded).
    /// When present, the signer tweaks its key package with this merkle root
    /// before generating commitments/shares (required for commitment-tweaked addresses).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merkle_root: Option<String>,
    /// Optional Solana on-chain verification data.
    /// When present, signer verifies the corresponding on-chain state via RPC.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solana_verification: Option<SolanaVerification>,
}

/// Round 1 response - commitment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round1Response {
    /// FROST commitment (serialized, hex-encoded)
    pub commitment: String,
    /// Signer identifier (for API)
    pub signer_id: u16,
    /// FROST identifier (hex-encoded, needed for round 2)
    pub frost_identifier: String,
}

/// Round 2 request - generate signature share
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round2Request {
    /// Session identifier (must match round 1)
    pub session_id: Uuid,
    /// Message hash to sign (hex-encoded 32 bytes)
    pub sighash: String,
    /// Optional tweak for Taproot key-path spending (hex-encoded 32 bytes)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tweak: Option<String>,
    /// Commitments from all participating signers
    /// Key is signer_id (u16), value is hex-encoded commitment
    pub commitments: BTreeMap<u16, String>,
    /// Mapping of signer_id to FROST identifier (hex-encoded)
    /// Required to properly reconstruct FROST identifiers
    #[serde(default)]
    pub identifier_map: BTreeMap<u16, String>,
    /// Optional BIP-341 merkle root for Taproot tweaked signing (hex-encoded).
    /// Must match the merkle_root from Round 1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merkle_root: Option<String>,
}

/// Round 2 response - signature share
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round2Response {
    /// FROST signature share (serialized, hex-encoded)
    pub signature_share: String,
    /// Signer identifier
    pub signer_id: u16,
}

/// DKG Round 1 request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DkgRound1Request {
    /// Ceremony identifier
    pub ceremony_id: Uuid,
    /// Threshold (t of n)
    pub threshold: u16,
    /// Total participants
    pub total_participants: u16,
}

/// DKG Round 1 response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DkgRound1Response {
    /// DKG round 1 package (serialized, hex-encoded)
    pub package: String,
    /// Signer identifier
    pub signer_id: u16,
    /// X25519 public key for E2E encrypted DKG round 2 (hex, 32 bytes)
    pub x25519_public_key: String,
}

/// DKG Round 2 request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DkgRound2Request {
    /// Ceremony identifier
    pub ceremony_id: Uuid,
    /// Round 1 packages from all participants (signer_id -> package)
    pub round1_packages: BTreeMap<u16, String>,
    /// X25519 public keys for E2E encryption (signer_id -> pubkey hex)
    pub x25519_pubkeys: BTreeMap<u16, String>,
}

/// DKG Round 2 response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DkgRound2Response {
    /// DKG round 2 packages (target_signer_id -> package)
    pub packages: BTreeMap<u16, String>,
    /// Signer identifier
    pub signer_id: u16,
}

/// DKG finalization request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DkgFinalizeRequest {
    /// Ceremony identifier
    pub ceremony_id: Uuid,
    /// Round 1 packages from all participants
    pub round1_packages: BTreeMap<u16, String>,
    /// Round 2 packages sent TO this signer (source_signer_id -> package)
    pub round2_packages: BTreeMap<u16, String>,
    /// X25519 public keys of senders for decryption (signer_id -> pubkey hex)
    pub x25519_pubkeys: BTreeMap<u16, String>,
}

/// DKG finalization response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DkgFinalizeResponse {
    /// Group public key (hex-encoded x-only 32 bytes)
    pub group_public_key: String,
    /// Whether key share was saved successfully
    pub saved: bool,
    /// Signer identifier
    pub signer_id: u16,
}

/// Broadcast channel: verify commitments request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyCommitmentsRequest {
    /// Session identifier (must match round 1)
    pub session_id: Uuid,
    /// All commitments from participating signers (signer_id -> commitment hex)
    pub commitments: BTreeMap<u16, String>,
    /// Identifier mapping (signer_id -> FROST identifier hex)
    #[serde(default)]
    pub identifier_map: BTreeMap<u16, String>,
}

/// Broadcast channel: verify commitments response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyCommitmentsResponse {
    /// Signer identifier
    pub signer_id: u16,
    /// SHA-256 digest of the canonical commitment data (hex)
    pub digest: String,
}

/// Generic error response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    /// Error code
    pub code: String,
    /// Human-readable error message
    pub message: String,
    /// Optional details
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl ErrorResponse {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }
}

/// Health check response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    /// Service status
    pub status: String,
    /// Signer identifier
    pub signer_id: u16,
    /// Whether key share is loaded
    pub key_loaded: bool,
}

/// Aggregation request - aggregate signature shares into final Schnorr signature
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregateRequest {
    /// Commitments from participating signers (signer_id -> commitment hex)
    pub commitments: BTreeMap<u16, String>,
    /// Identifier mapping (signer_id -> FROST identifier hex)
    pub identifier_map: BTreeMap<u16, String>,
    /// Signature shares from participating signers (signer_id -> share hex)
    pub signature_shares: BTreeMap<u16, String>,
    /// The sighash that was signed (hex-encoded 32 bytes)
    pub sighash: String,
    /// Optional Taproot merkle root for BIP-341 tweaked aggregation (hex-encoded).
    /// When present, uses `aggregate_with_tweak` so the signature verifies against
    /// the BIP-341 tweaked output key rather than the raw internal key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merkle_root: Option<String>,
}

/// Aggregation response - final Schnorr signature
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregateResponse {
    /// The aggregated Schnorr signature (64 bytes hex)
    pub signature: String,
    /// Group public key (x-only, 32 bytes hex)
    pub group_public_key: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_round1_request_serialization() {
        let req = Round1Request {
            session_id: Uuid::new_v4(),
            sighash: "a".repeat(64),
            tweak: None,
            signing_context: None,
            merkle_root: None,
            solana_verification: None,
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: Round1Request = serde_json::from_str(&json).unwrap();
        assert_eq!(req.session_id, parsed.session_id);
    }

    #[test]
    fn test_error_response() {
        let err = ErrorResponse::new("INVALID_SESSION", "Session not found")
            .with_details("session_id: 123");
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("INVALID_SESSION"));
    }
}
