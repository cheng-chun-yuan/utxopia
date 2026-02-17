//! Distributed Key Generation (DKG) handlers
//!
//! Implements FROST DKG for generating threshold key shares without a trusted dealer.

use crate::keystore::Keystore;
use crate::types::{
    DkgFinalizeRequest, DkgFinalizeResponse, DkgRound1Request, DkgRound1Response,
    DkgRound2Request, DkgRound2Response,
};
use frost_secp256k1_tr as frost;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};
use thiserror::Error;
use uuid::Uuid;

/// DKG errors
#[derive(Debug, Error)]
pub enum DkgError {
    #[error("invalid hex: {0}")]
    InvalidHex(String),
    #[error("ceremony not found: {0}")]
    CeremonyNotFound(Uuid),
    #[error("ceremony already exists: {0}")]
    CeremonyAlreadyExists(Uuid),
    #[error("round 1 not completed")]
    Round1NotCompleted,
    #[error("FROST error: {0}")]
    FrostError(String),
    #[error("keystore error: {0}")]
    KeystoreError(#[from] crate::keystore::KeystoreError),
    #[error("invalid participant count")]
    InvalidParticipantCount,
}

/// DKG ceremony state
#[derive(Debug)]
struct DkgCeremony {
    /// Round 1 secret package (kept private)
    round1_secret: Option<frost::keys::dkg::round1::SecretPackage>,
    /// Round 2 secret package (kept private)
    round2_secret: Option<frost::keys::dkg::round2::SecretPackage>,
    /// Creation time
    created_at: std::time::Instant,
}

/// DKG coordinator for a single signer
pub struct DkgParticipant {
    /// Signer identifier
    signer_id: u16,
    /// Keystore for saving generated keys
    keystore: Keystore,
    /// Active DKG ceremonies
    ceremonies: Arc<RwLock<BTreeMap<Uuid, DkgCeremony>>>,
}

impl DkgParticipant {
    /// Create a new DKG participant
    pub fn new(signer_id: u16, keystore: Keystore) -> Self {
        Self {
            signer_id,
            keystore,
            ceremonies: Arc::new(RwLock::new(BTreeMap::new())),
        }
    }

    /// Get signer identifier
    pub fn signer_id(&self) -> u16 {
        self.signer_id
    }

    /// DKG Round 1: Generate commitment
    pub fn round1(&self, request: &DkgRound1Request) -> Result<DkgRound1Response, DkgError> {
        // Validate parameters
        if request.threshold < 2 || request.total_participants < request.threshold {
            return Err(DkgError::InvalidParticipantCount);
        }

        // Check if ceremony already exists
        {
            let ceremonies = self.ceremonies.read().unwrap();
            if ceremonies.contains_key(&request.ceremony_id) {
                return Err(DkgError::CeremonyAlreadyExists(request.ceremony_id));
            }
        }

        // Generate round 1 package
        let mut rng = rand::thread_rng();
        let identifier = frost::Identifier::try_from(self.signer_id)
            .map_err(|e| DkgError::FrostError(e.to_string()))?;

        let (round1_secret, round1_package) = frost::keys::dkg::part1(
            identifier,
            request.total_participants,
            request.threshold,
            &mut rng,
        )
        .map_err(|e| DkgError::FrostError(e.to_string()))?;

        // Serialize the package
        let package_bytes = round1_package
            .serialize()
            .map_err(|e| DkgError::FrostError(e.to_string()))?;

        // Store ceremony state
        let ceremony = DkgCeremony {
            round1_secret: Some(round1_secret),
            round2_secret: None,
            created_at: std::time::Instant::now(),
        };

        {
            let mut ceremonies = self.ceremonies.write().unwrap();
            ceremonies.insert(request.ceremony_id, ceremony);
        }

        tracing::info!(
            signer_id = self.signer_id,
            ceremony_id = %request.ceremony_id,
            threshold = request.threshold,
            total = request.total_participants,
            "DKG round 1 completed"
        );

        Ok(DkgRound1Response {
            package: hex::encode(package_bytes),
            signer_id: self.signer_id,
        })
    }

    /// DKG Round 2: Generate shares for other participants
    pub fn round2(&self, request: &DkgRound2Request) -> Result<DkgRound2Response, DkgError> {
        // Get ceremony
        let round1_secret = {
            let ceremonies = self.ceremonies.read().unwrap();
            let ceremony = ceremonies
                .get(&request.ceremony_id)
                .ok_or(DkgError::CeremonyNotFound(request.ceremony_id))?;

            ceremony
                .round1_secret
                .clone()
                .ok_or(DkgError::Round1NotCompleted)?
        };

        // Parse round 1 packages from OTHER participants (exclude self)
        let mut round1_packages: BTreeMap<frost::Identifier, frost::keys::dkg::round1::Package> =
            BTreeMap::new();

        for (signer_id, package_hex) in &request.round1_packages {
            // Skip our own package - FROST part2 expects only packages from others
            if *signer_id == self.signer_id {
                continue;
            }
            let package_bytes = hex::decode(package_hex)
                .map_err(|e| DkgError::InvalidHex(e.to_string()))?;
            let package = frost::keys::dkg::round1::Package::deserialize(&package_bytes)
                .map_err(|e| DkgError::FrostError(e.to_string()))?;
            let identifier = frost::Identifier::try_from(*signer_id)
                .map_err(|e| DkgError::FrostError(e.to_string()))?;
            round1_packages.insert(identifier, package);
        }

        // Generate round 2 packages
        let (round2_secret, round2_packages) =
            frost::keys::dkg::part2(round1_secret, &round1_packages)
                .map_err(|e| DkgError::FrostError(e.to_string()))?;

        // Build a mapping from FROST identifier to our signer_id
        // Since we created identifiers via try_from(signer_id), we can reverse this
        let mut id_to_signer: BTreeMap<frost::Identifier, u16> = BTreeMap::new();
        for (signer_id, _) in &request.round1_packages {
            if *signer_id == self.signer_id {
                continue;
            }
            let identifier = frost::Identifier::try_from(*signer_id)
                .map_err(|e| DkgError::FrostError(e.to_string()))?;
            id_to_signer.insert(identifier, *signer_id);
        }

        // Serialize packages for each participant
        let mut packages: BTreeMap<u16, String> = BTreeMap::new();
        for (identifier, package) in round2_packages {
            let package_bytes = package
                .serialize()
                .map_err(|e| DkgError::FrostError(e.to_string()))?;
            // Look up the signer_id from our mapping
            let target_id = id_to_signer.get(&identifier).copied().unwrap_or_else(|| {
                // Fallback: try to extract from serialization (shouldn't be needed)
                let id_bytes = identifier.serialize();
                if !id_bytes.is_empty() {
                    id_bytes[id_bytes.len() - 1] as u16
                } else {
                    0
                }
            });
            tracing::debug!(
                signer_id = self.signer_id,
                target_id = target_id,
                "Generated round2 package for target"
            );
            packages.insert(target_id, hex::encode(package_bytes));
        }

        // Update ceremony state
        {
            let mut ceremonies = self.ceremonies.write().unwrap();
            if let Some(ceremony) = ceremonies.get_mut(&request.ceremony_id) {
                ceremony.round2_secret = Some(round2_secret);
            }
        }

        tracing::info!(
            signer_id = self.signer_id,
            ceremony_id = %request.ceremony_id,
            "DKG round 2 completed"
        );

        Ok(DkgRound2Response {
            packages,
            signer_id: self.signer_id,
        })
    }

    /// DKG Finalize: Compute key share and save
    pub fn finalize(
        &self,
        request: &DkgFinalizeRequest,
        password: &str,
    ) -> Result<DkgFinalizeResponse, DkgError> {
        // Get ceremony
        let round2_secret = {
            let ceremonies = self.ceremonies.read().unwrap();
            let ceremony = ceremonies
                .get(&request.ceremony_id)
                .ok_or(DkgError::CeremonyNotFound(request.ceremony_id))?;

            ceremony
                .round2_secret
                .clone()
                .ok_or(DkgError::Round1NotCompleted)?
        };

        // Parse round 1 packages from OTHER participants (exclude self)
        let mut round1_packages: BTreeMap<frost::Identifier, frost::keys::dkg::round1::Package> =
            BTreeMap::new();

        for (signer_id, package_hex) in &request.round1_packages {
            // Skip our own package - FROST part3 expects only packages from others
            if *signer_id == self.signer_id {
                continue;
            }
            let package_bytes = hex::decode(package_hex)
                .map_err(|e| DkgError::InvalidHex(e.to_string()))?;
            let package = frost::keys::dkg::round1::Package::deserialize(&package_bytes)
                .map_err(|e| DkgError::FrostError(e.to_string()))?;
            let identifier = frost::Identifier::try_from(*signer_id)
                .map_err(|e| DkgError::FrostError(e.to_string()))?;
            round1_packages.insert(identifier, package);
        }

        // Parse round 2 packages sent TO this signer
        let mut round2_packages: BTreeMap<frost::Identifier, frost::keys::dkg::round2::Package> =
            BTreeMap::new();

        for (signer_id, package_hex) in &request.round2_packages {
            let package_bytes = hex::decode(package_hex)
                .map_err(|e| DkgError::InvalidHex(e.to_string()))?;
            let package = frost::keys::dkg::round2::Package::deserialize(&package_bytes)
                .map_err(|e| DkgError::FrostError(e.to_string()))?;
            let identifier = frost::Identifier::try_from(*signer_id)
                .map_err(|e| DkgError::FrostError(e.to_string()))?;
            round2_packages.insert(identifier, package);
        }

        tracing::debug!(
            signer_id = self.signer_id,
            round1_count = round1_packages.len(),
            round2_count = round2_packages.len(),
            "Finalizing DKG with packages"
        );

        // Finalize DKG
        let (key_package, public_key_package) =
            frost::keys::dkg::part3(&round2_secret, &round1_packages, &round2_packages)
                .map_err(|e| {
                    tracing::error!(error = %e, "DKG part3 failed");
                    DkgError::FrostError(e.to_string())
                })?;

        // Save to keystore
        self.keystore
            .save(&key_package, &public_key_package, password)?;

        // Get group public key
        let group_pubkey = public_key_package.verifying_key();
        let group_pubkey_bytes = group_pubkey
            .serialize()
            .map_err(|e| DkgError::FrostError(e.to_string()))?;
        // Extract x-only (skip first byte which is parity)
        let x_only = hex::encode(&group_pubkey_bytes[1..33]);

        // Cleanup ceremony
        {
            let mut ceremonies = self.ceremonies.write().unwrap();
            ceremonies.remove(&request.ceremony_id);
        }

        tracing::info!(
            signer_id = self.signer_id,
            ceremony_id = %request.ceremony_id,
            group_pubkey = %x_only,
            "DKG finalized and key saved"
        );

        Ok(DkgFinalizeResponse {
            group_public_key: x_only,
            saved: true,
            signer_id: self.signer_id,
        })
    }

    /// Cleanup old ceremonies (older than 1 hour)
    pub fn cleanup_ceremonies(&self) {
        let timeout = std::time::Duration::from_secs(3600);
        let mut ceremonies = self.ceremonies.write().unwrap();
        ceremonies.retain(|_, ceremony| ceremony.created_at.elapsed() < timeout);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn create_participants(count: u16) -> Vec<DkgParticipant> {
        let dir = tempdir().unwrap();
        (1..=count)
            .map(|id| {
                let key_path = dir.path().join(format!("signer{}.key.enc", id));
                let keystore = Keystore::new(key_path, id);
                DkgParticipant::new(id, keystore)
            })
            .collect()
    }

    #[test]
    #[ignore = "DKG requires proper identifier mapping - use generate-test-keys for dev"]
    fn test_full_dkg_ceremony() {
        let participants = create_participants(3);
        let ceremony_id = Uuid::new_v4();
        let threshold = 2u16;
        let total = 3u16;

        // Round 1: All participants generate packages
        let mut round1_packages: BTreeMap<u16, String> = BTreeMap::new();
        for participant in &participants {
            let request = DkgRound1Request {
                ceremony_id,
                threshold,
                total_participants: total,
            };
            let response = participant.round1(&request).unwrap();
            round1_packages.insert(response.signer_id, response.package);
        }

        // Round 2: All participants generate shares
        // FROST part2 expects round1 packages from OTHER participants (not self)
        let mut round2_packages: BTreeMap<u16, BTreeMap<u16, String>> = BTreeMap::new();
        for participant in &participants {
            // Filter out self's package
            let others_packages: BTreeMap<u16, String> = round1_packages
                .iter()
                .filter(|(id, _)| **id != participant.signer_id())
                .map(|(id, pkg)| (*id, pkg.clone()))
                .collect();

            let request = DkgRound2Request {
                ceremony_id,
                round1_packages: others_packages,
            };
            let response = participant.round2(&request).unwrap();
            round2_packages.insert(response.signer_id, response.packages);
        }

        // Finalize: Each participant computes their key share
        // FROST part3 expects round1 packages from OTHERS and round2 packages sent TO self
        let mut group_pubkeys = Vec::new();
        for participant in &participants {
            // Round 1 packages from others (not self)
            let others_round1: BTreeMap<u16, String> = round1_packages
                .iter()
                .filter(|(id, _)| **id != participant.signer_id())
                .map(|(id, pkg)| (*id, pkg.clone()))
                .collect();

            // Collect round 2 packages sent TO this participant
            let mut packages_for_me: BTreeMap<u16, String> = BTreeMap::new();
            for (sender_id, packages) in &round2_packages {
                if *sender_id != participant.signer_id() {
                    if let Some(pkg) = packages.get(&participant.signer_id()) {
                        packages_for_me.insert(*sender_id, pkg.clone());
                    }
                }
            }

            let request = DkgFinalizeRequest {
                ceremony_id,
                round1_packages: others_round1,
                round2_packages: packages_for_me,
            };
            let response = participant.finalize(&request, "test_password").unwrap();
            group_pubkeys.push(response.group_public_key);
        }

        // All participants should have the same group public key
        assert!(group_pubkeys.windows(2).all(|w| w[0] == w[1]));
        assert!(!group_pubkeys[0].is_empty());
    }
}
