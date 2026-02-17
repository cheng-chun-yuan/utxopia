//! FROST signing round handlers
//!
//! Implements the two-round FROST signing protocol for threshold Schnorr signatures.

use crate::types::{Round1Request, Round1Response, Round2Request, Round2Response};
use frost_secp256k1_tr as frost;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};
use thiserror::Error;
use uuid::Uuid;

/// Signing errors
#[derive(Debug, Error)]
pub enum SigningError {
    #[error("invalid hex: {0}")]
    InvalidHex(String),
    #[error("invalid sighash length: expected 32 bytes")]
    InvalidSighashLength,
    #[error("invalid tweak length: expected 32 bytes")]
    InvalidTweakLength,
    #[error("session not found: {0}")]
    SessionNotFound(Uuid),
    #[error("session already used for round 2")]
    SessionAlreadyUsed,
    #[error("missing commitment for signer {0}")]
    MissingCommitment(u16),
    #[error("FROST error: {0}")]
    FrostError(String),
    #[error("key not loaded")]
    KeyNotLoaded,
}

/// Session state for tracking signing rounds
#[derive(Debug)]
struct SigningSession {
    /// Nonces generated in round 1
    nonces: frost::round1::SigningNonces,
    /// Commitment generated in round 1
    commitment: frost::round1::SigningCommitments,
    /// Whether round 2 has been completed
    round2_completed: bool,
    /// Session creation time for cleanup
    created_at: std::time::Instant,
}

/// FROST signer state
pub struct FrostSigner {
    /// Signer identifier (for API responses)
    signer_id: u16,
    /// Key package (private share)
    key_package: frost::keys::KeyPackage,
    /// Public key package (group info)
    pub public_key_package: frost::keys::PublicKeyPackage,
    /// Active signing sessions
    sessions: Arc<RwLock<HashMap<Uuid, SigningSession>>>,
}

impl FrostSigner {
    /// Create a new FROST signer
    pub fn new(
        signer_id: u16,
        key_package: frost::keys::KeyPackage,
        public_key_package: frost::keys::PublicKeyPackage,
    ) -> Self {
        Self {
            signer_id,
            key_package,
            public_key_package,
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Get signer identifier (for API)
    pub fn signer_id(&self) -> u16 {
        self.signer_id
    }

    /// Get the FROST identifier from the key package
    pub fn frost_identifier(&self) -> frost::Identifier {
        *self.key_package.identifier()
    }

    /// Get the group public key (x-only, 32 bytes)
    pub fn group_public_key(&self) -> [u8; 32] {
        let vk = self.public_key_package.verifying_key();
        // The FROST verifying key serializes as 33-byte compressed point
        // For Taproot, we need x-only (32 bytes)
        let serialized = vk
            .serialize()
            .expect("verifying key serialization should not fail");
        // First byte is the parity, remaining 32 are x-coordinate
        let mut x_only = [0u8; 32];
        x_only.copy_from_slice(&serialized[1..33]);
        x_only
    }

    /// Get the verifying share (public key share)
    pub fn public_key_share(&self) -> Vec<u8> {
        self.key_package
            .verifying_share()
            .serialize()
            .expect("verifying share serialization should not fail")
    }

    /// Get threshold and total participants
    pub fn threshold_info(&self) -> (u16, u16) {
        let min = *self.key_package.min_signers();
        let total = self.public_key_package.verifying_shares().len() as u16;
        (min, total)
    }

    /// Round 1: Generate commitment
    pub fn round1(&self, request: &Round1Request) -> Result<Round1Response, SigningError> {
        // Validate sighash
        let sighash_bytes = hex::decode(&request.sighash)
            .map_err(|e| SigningError::InvalidHex(e.to_string()))?;
        if sighash_bytes.len() != 32 {
            return Err(SigningError::InvalidSighashLength);
        }

        // Validate tweak if present
        if let Some(ref tweak) = request.tweak {
            let tweak_bytes =
                hex::decode(tweak).map_err(|e| SigningError::InvalidHex(e.to_string()))?;
            if tweak_bytes.len() != 32 {
                return Err(SigningError::InvalidTweakLength);
            }
        }

        // Generate nonces and commitment
        let mut rng = rand::thread_rng();
        let (nonces, commitments) = frost::round1::commit(self.key_package.signing_share(), &mut rng);

        // Serialize commitment
        let commitment_bytes = commitments
            .serialize()
            .map_err(|e| SigningError::FrostError(e.to_string()))?;

        // Store session
        let session = SigningSession {
            nonces,
            commitment: commitments,
            round2_completed: false,
            created_at: std::time::Instant::now(),
        };

        {
            let mut sessions = self.sessions.write().unwrap();
            sessions.insert(request.session_id, session);
        }

        // Serialize FROST identifier
        let frost_id_bytes = self.key_package.identifier().serialize();

        tracing::debug!(
            signer_id = self.signer_id,
            session_id = %request.session_id,
            "Generated round 1 commitment"
        );

        Ok(Round1Response {
            commitment: hex::encode(commitment_bytes),
            signer_id: self.signer_id,
            frost_identifier: hex::encode(frost_id_bytes),
        })
    }

    /// Round 2: Generate signature share
    pub fn round2(&self, request: &Round2Request) -> Result<Round2Response, SigningError> {
        // Parse sighash
        let sighash_bytes = hex::decode(&request.sighash)
            .map_err(|e| SigningError::InvalidHex(e.to_string()))?;
        if sighash_bytes.len() != 32 {
            return Err(SigningError::InvalidSighashLength);
        }
        let mut sighash = [0u8; 32];
        sighash.copy_from_slice(&sighash_bytes);

        // Get and validate session
        let session = {
            let mut sessions = self.sessions.write().unwrap();
            let session = sessions
                .get_mut(&request.session_id)
                .ok_or(SigningError::SessionNotFound(request.session_id))?;

            if session.round2_completed {
                return Err(SigningError::SessionAlreadyUsed);
            }
            session.round2_completed = true;

            // Clone what we need and drop the lock
            SigningSession {
                nonces: session.nonces.clone(),
                commitment: session.commitment,
                round2_completed: true,
                created_at: session.created_at,
            }
        };

        // Parse commitments from all signers
        let mut commitments_map: BTreeMap<frost::Identifier, frost::round1::SigningCommitments> =
            BTreeMap::new();

        for (signer_id, commitment_hex) in &request.commitments {
            let commitment_bytes = hex::decode(commitment_hex)
                .map_err(|e| SigningError::InvalidHex(e.to_string()))?;
            let commitment = frost::round1::SigningCommitments::deserialize(&commitment_bytes)
                .map_err(|e| SigningError::FrostError(e.to_string()))?;

            // Get FROST identifier from the map, or try to derive from u16
            let identifier = if let Some(frost_id_hex) = request.identifier_map.get(signer_id) {
                let frost_id_bytes = hex::decode(frost_id_hex)
                    .map_err(|e| SigningError::InvalidHex(e.to_string()))?;
                frost::Identifier::deserialize(&frost_id_bytes)
                    .map_err(|e| SigningError::FrostError(e.to_string()))?
            } else {
                // Fallback: try to create identifier from u16 (may not work with all FROST configs)
                frost::Identifier::try_from(*signer_id)
                    .map_err(|e| SigningError::FrostError(format!("No identifier mapping for signer {}: {}", signer_id, e)))?
            };
            commitments_map.insert(identifier, commitment);
        }

        // Create signing package
        let signing_package = frost::SigningPackage::new(commitments_map, &sighash);

        // Generate signature share
        let signature_share = frost::round2::sign(&signing_package, &session.nonces, &self.key_package)
            .map_err(|e| SigningError::FrostError(e.to_string()))?;

        // Serialize signature share
        let share_bytes = signature_share.serialize();

        tracing::debug!(
            signer_id = self.signer_id,
            session_id = %request.session_id,
            "Generated round 2 signature share"
        );

        Ok(Round2Response {
            signature_share: hex::encode(share_bytes),
            signer_id: self.signer_id,
        })
    }

    /// Cleanup old sessions (older than 5 minutes)
    pub fn cleanup_sessions(&self) {
        let timeout = std::time::Duration::from_secs(300);
        let mut sessions = self.sessions.write().unwrap();
        sessions.retain(|_, session| session.created_at.elapsed() < timeout);
    }

    /// Get number of active sessions
    pub fn active_sessions(&self) -> usize {
        self.sessions.read().unwrap().len()
    }
}

/// Aggregate signature shares into final signature
///
/// This is called by the coordinator (backend) after collecting shares from threshold signers.
pub fn aggregate_signatures(
    signing_package: &frost::SigningPackage,
    signature_shares: &BTreeMap<frost::Identifier, frost::round2::SignatureShare>,
    public_key_package: &frost::keys::PublicKeyPackage,
) -> Result<[u8; 64], SigningError> {
    let signature = frost::aggregate(signing_package, signature_shares, public_key_package)
        .map_err(|e| SigningError::FrostError(e.to_string()))?;

    let sig_bytes = signature
        .serialize()
        .map_err(|e| SigningError::FrostError(e.to_string()))?;

    // Convert Vec<u8> to [u8; 64]
    let mut result = [0u8; 64];
    if sig_bytes.len() != 64 {
        return Err(SigningError::FrostError(format!(
            "Invalid signature length: expected 64, got {}",
            sig_bytes.len()
        )));
    }
    result.copy_from_slice(&sig_bytes);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use frost_secp256k1_tr as frost;
    use rand::rngs::OsRng;

    /// Setup signers with their actual FROST identifiers
    fn setup_signers() -> Vec<FrostSigner> {
        let mut rng = OsRng;
        let max_signers = 3u16;
        let min_signers = 2u16;

        // Generate key shares using trusted dealer (for testing)
        let (shares, pubkey_package) =
            frost::keys::generate_with_dealer(max_signers, min_signers, frost::keys::IdentifierList::Default, &mut rng)
                .expect("DKG failed");

        // Create signers by converting SecretShare to KeyPackage
        shares
            .into_iter()
            .enumerate()
            .filter_map(|(idx, (_, secret_share))| {
                let signer_id = (idx + 1) as u16;
                let key_package = frost::keys::KeyPackage::try_from(secret_share).ok()?;
                Some(FrostSigner::new(signer_id, key_package, pubkey_package.clone()))
            })
            .collect()
    }

    #[test]
    fn test_round1_generates_commitment() {
        let signers = setup_signers();
        let signer = &signers[0];

        let request = Round1Request {
            session_id: Uuid::new_v4(),
            sighash: hex::encode([0x42u8; 32]),
            tweak: None,
        };

        let response = signer.round1(&request).unwrap();
        assert!(!response.commitment.is_empty());
        assert!(!response.frost_identifier.is_empty());
        assert_eq!(response.signer_id, signer.signer_id());
    }

    #[test]
    fn test_full_signing_flow() {
        let signers = setup_signers();
        let session_id = Uuid::new_v4();
        let sighash = [0x42u8; 32];

        // Round 1: Collect commitments and identifiers from 2 signers (threshold)
        let mut commitments_by_signer: BTreeMap<u16, String> = BTreeMap::new();
        let mut identifier_map: BTreeMap<u16, String> = BTreeMap::new();
        let mut frost_ids: Vec<frost::Identifier> = Vec::new();

        for signer in signers.iter().take(2) {
            let request = Round1Request {
                session_id,
                sighash: hex::encode(sighash),
                tweak: None,
            };
            let response = signer.round1(&request).unwrap();
            commitments_by_signer.insert(response.signer_id, response.commitment);
            identifier_map.insert(response.signer_id, response.frost_identifier.clone());

            // Parse the FROST identifier for aggregation
            let frost_id_bytes = hex::decode(&response.frost_identifier).unwrap();
            frost_ids.push(frost::Identifier::deserialize(&frost_id_bytes).unwrap());
        }

        // Round 2: Collect signature shares
        let mut signature_shares: BTreeMap<frost::Identifier, frost::round2::SignatureShare> = BTreeMap::new();

        for (idx, signer) in signers.iter().take(2).enumerate() {
            let request = Round2Request {
                session_id,
                sighash: hex::encode(sighash),
                tweak: None,
                commitments: commitments_by_signer.clone(),
                identifier_map: identifier_map.clone(),
            };
            let response = signer.round2(&request).unwrap();
            let share_bytes = hex::decode(&response.signature_share).unwrap();
            let share = frost::round2::SignatureShare::deserialize(&share_bytes).unwrap();
            signature_shares.insert(frost_ids[idx], share);
        }

        // Build FROST commitments map with actual identifiers
        let mut frost_commitments: BTreeMap<frost::Identifier, frost::round1::SigningCommitments> = BTreeMap::new();
        for (idx, (_, commitment_hex)) in commitments_by_signer.iter().enumerate() {
            let bytes = hex::decode(commitment_hex).unwrap();
            let commitment = frost::round1::SigningCommitments::deserialize(&bytes).unwrap();
            frost_commitments.insert(frost_ids[idx], commitment);
        }

        let signing_package = frost::SigningPackage::new(frost_commitments, &sighash);
        let pubkey_package = signers[0].public_key_package.clone();

        let signature = aggregate_signatures(&signing_package, &signature_shares, &pubkey_package).unwrap();
        assert_eq!(signature.len(), 64);
    }

    #[test]
    fn test_session_reuse_fails() {
        let signers = setup_signers();
        let signer = &signers[0];
        let session_id = Uuid::new_v4();

        let request1 = Round1Request {
            session_id,
            sighash: hex::encode([0x42u8; 32]),
            tweak: None,
        };
        let response1 = signer.round1(&request1).unwrap();

        // Build commitments with FROST identifier mapping
        let mut commitments = BTreeMap::new();
        commitments.insert(response1.signer_id, response1.commitment.clone());

        let mut identifier_map = BTreeMap::new();
        identifier_map.insert(response1.signer_id, response1.frost_identifier);

        let request2 = Round2Request {
            session_id,
            sighash: hex::encode([0x42u8; 32]),
            tweak: None,
            commitments,
            identifier_map,
        };

        // First round 2 should succeed
        let _ = signer.round2(&request2);

        // Second round 2 should fail because session was used
        let result = signer.round2(&request2);
        assert!(matches!(result, Err(SigningError::SessionAlreadyUsed)));
    }
}
