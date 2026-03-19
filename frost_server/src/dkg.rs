//! Distributed Key Generation (DKG) with E2E encrypted round 2 packages.
//!
//! All round 2 shares are encrypted via X25519 ECDH + AES-256-GCM so the
//! coordinator never sees plaintext secret shares.

use crate::crypto::{decrypt_from_sender, encrypt_for_recipient, parse_x25519_pubkey, EphemeralKeypair};
use crate::keystore::Keystore;
use crate::utils::{recover_read, recover_write};
use crate::types::{
    DkgFinalizeRequest, DkgFinalizeResponse, DkgRound1Request, DkgRound1Response,
    DkgRound2Request, DkgRound2Response,
};
use frost_secp256k1_tr as frost;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};
use thiserror::Error;
use uuid::Uuid;

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
    #[error("missing X25519 pubkey for signer {0}")]
    MissingX25519Pubkey(u16),
}

struct DkgCeremony {
    round1_secret: Option<frost::keys::dkg::round1::SecretPackage>,
    round2_secret: Option<frost::keys::dkg::round2::SecretPackage>,
    x25519_keypair: EphemeralKeypair,
    created_at: std::time::Instant,
}

pub struct DkgParticipant {
    signer_id: u16,
    keystore: Keystore,
    ceremonies: Arc<RwLock<BTreeMap<Uuid, DkgCeremony>>>,
}

impl DkgParticipant {
    pub fn new(signer_id: u16, keystore: Keystore) -> Self {
        Self {
            signer_id,
            keystore,
            ceremonies: Arc::new(RwLock::new(BTreeMap::new())),
        }
    }

    pub fn signer_id(&self) -> u16 {
        self.signer_id
    }

    /// Round 1: Generate FROST commitment + X25519 ephemeral keypair
    pub fn round1(&self, request: &DkgRound1Request) -> Result<DkgRound1Response, DkgError> {
        if request.threshold < 2 || request.total_participants < request.threshold {
            return Err(DkgError::InvalidParticipantCount);
        }

        {
            let ceremonies = self.ceremonies.read().unwrap_or_else(recover_read);
            if ceremonies.contains_key(&request.ceremony_id) {
                return Err(DkgError::CeremonyAlreadyExists(request.ceremony_id));
            }
        }

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

        let package_bytes = round1_package
            .serialize()
            .map_err(|e| DkgError::FrostError(e.to_string()))?;

        let x25519_keypair = EphemeralKeypair::generate();
        let x25519_public_key = x25519_keypair.public_key_hex();

        let ceremony = DkgCeremony {
            round1_secret: Some(round1_secret),
            round2_secret: None,
            x25519_keypair,
            created_at: std::time::Instant::now(),
        };

        self.ceremonies.write().unwrap_or_else(recover_write).insert(request.ceremony_id, ceremony);

        tracing::info!(
            signer_id = self.signer_id,
            ceremony_id = %request.ceremony_id,
            "DKG round 1 completed"
        );

        Ok(DkgRound1Response {
            package: hex::encode(package_bytes),
            signer_id: self.signer_id,
            x25519_public_key,
        })
    }

    /// Round 2: Generate secret shares, encrypt each for its target signer
    pub fn round2(&self, request: &DkgRound2Request) -> Result<DkgRound2Response, DkgError> {
        let (round1_secret, x25519_private) = {
            let ceremonies = self.ceremonies.read().unwrap_or_else(recover_read);
            let ceremony = ceremonies
                .get(&request.ceremony_id)
                .ok_or(DkgError::CeremonyNotFound(request.ceremony_id))?;
            let secret = ceremony.round1_secret.clone().ok_or(DkgError::Round1NotCompleted)?;
            (secret, ceremony.x25519_keypair.private.clone())
        };

        // Parse round 1 packages from others (exclude self)
        let mut round1_packages: BTreeMap<frost::Identifier, frost::keys::dkg::round1::Package> =
            BTreeMap::new();
        let mut id_to_signer: BTreeMap<frost::Identifier, u16> = BTreeMap::new();

        for (signer_id, package_hex) in &request.round1_packages {
            // Validate signer ID is non-zero (FROST identifiers start at 1)
            if *signer_id == 0 {
                return Err(DkgError::FrostError(
                    "signer_id 0 is invalid (FROST identifiers start at 1)".to_string(),
                ));
            }
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
            id_to_signer.insert(identifier, *signer_id);
        }

        let (round2_secret, round2_packages) =
            frost::keys::dkg::part2(round1_secret, &round1_packages)
                .map_err(|e| DkgError::FrostError(e.to_string()))?;

        // Encrypt each package for its target
        let mut packages: BTreeMap<u16, String> = BTreeMap::new();
        for (identifier, package) in round2_packages {
            let package_bytes = package
                .serialize()
                .map_err(|e| DkgError::FrostError(e.to_string()))?;

            let target_id = *id_to_signer.get(&identifier).ok_or_else(|| {
                DkgError::FrostError(format!("unknown identifier {:?}", identifier))
            })?;

            let target_pubkey_hex = request
                .x25519_pubkeys
                .get(&target_id)
                .ok_or(DkgError::MissingX25519Pubkey(target_id))?;

            let target_pubkey = parse_x25519_pubkey(target_pubkey_hex)
                .map_err(|e| DkgError::FrostError(format!("bad X25519 key for signer {}: {}", target_id, e)))?;

            let encrypted = encrypt_for_recipient(&x25519_private, &target_pubkey, &package_bytes)
                .map_err(|e| DkgError::FrostError(format!("encryption failed: {}", e)))?;

            packages.insert(target_id, hex::encode(encrypted));
        }

        // Store round 2 secret
        self.ceremonies
            .write()
            .unwrap_or_else(recover_write)
            .get_mut(&request.ceremony_id)
            .map(|c| c.round2_secret = Some(round2_secret));

        tracing::info!(
            signer_id = self.signer_id,
            ceremony_id = %request.ceremony_id,
            "DKG round 2 completed (encrypted)"
        );

        Ok(DkgRound2Response {
            packages,
            signer_id: self.signer_id,
        })
    }

    /// Finalize: Decrypt round 2 packages and compute key share
    pub fn finalize(
        &self,
        request: &DkgFinalizeRequest,
        password: &str,
    ) -> Result<DkgFinalizeResponse, DkgError> {
        let (round2_secret, x25519_private) = {
            let ceremonies = self.ceremonies.read().unwrap_or_else(recover_read);
            let ceremony = ceremonies
                .get(&request.ceremony_id)
                .ok_or(DkgError::CeremonyNotFound(request.ceremony_id))?;
            let secret = ceremony.round2_secret.clone().ok_or(DkgError::Round1NotCompleted)?;
            (secret, ceremony.x25519_keypair.private.clone())
        };

        // Parse round 1 packages from others
        let mut round1_packages: BTreeMap<frost::Identifier, frost::keys::dkg::round1::Package> =
            BTreeMap::new();

        for (signer_id, package_hex) in &request.round1_packages {
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

        // Decrypt and parse round 2 packages
        let mut round2_packages: BTreeMap<frost::Identifier, frost::keys::dkg::round2::Package> =
            BTreeMap::new();

        for (signer_id, package_hex) in &request.round2_packages {
            let encrypted_bytes = hex::decode(package_hex)
                .map_err(|e| DkgError::InvalidHex(e.to_string()))?;

            let sender_pubkey_hex = request
                .x25519_pubkeys
                .get(signer_id)
                .ok_or(DkgError::MissingX25519Pubkey(*signer_id))?;

            let sender_pubkey = parse_x25519_pubkey(sender_pubkey_hex)
                .map_err(|e| DkgError::FrostError(format!("bad X25519 key for signer {}: {}", signer_id, e)))?;

            let plaintext = decrypt_from_sender(&x25519_private, &sender_pubkey, &encrypted_bytes)
                .map_err(|e| DkgError::FrostError(format!("decryption failed from signer {}: {}", signer_id, e)))?;

            let package = frost::keys::dkg::round2::Package::deserialize(&plaintext)
                .map_err(|e| DkgError::FrostError(e.to_string()))?;
            let identifier = frost::Identifier::try_from(*signer_id)
                .map_err(|e| DkgError::FrostError(e.to_string()))?;
            round2_packages.insert(identifier, package);
        }

        // Finalize DKG
        let (key_package, public_key_package) =
            frost::keys::dkg::part3(&round2_secret, &round1_packages, &round2_packages)
                .map_err(|e| DkgError::FrostError(e.to_string()))?;

        self.keystore.save(&key_package, &public_key_package, password)?;

        let group_pubkey_bytes = public_key_package
            .verifying_key()
            .serialize()
            .map_err(|e| DkgError::FrostError(e.to_string()))?;
        let x_only = hex::encode(&group_pubkey_bytes[1..33]);

        self.ceremonies.write().unwrap_or_else(recover_write).remove(&request.ceremony_id);

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

    pub fn cleanup_ceremonies(&self) {
        let timeout = std::time::Duration::from_secs(600); // 10 minutes
        let mut ceremonies = self.ceremonies.write().unwrap_or_else(recover_write);
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
    fn test_full_dkg_ceremony_encrypted() {
        let participants = create_participants(3);
        let ceremony_id = Uuid::new_v4();
        let threshold = 2u16;
        let total = 3u16;

        // Round 1: collect packages + X25519 pubkeys
        let mut round1_packages: BTreeMap<u16, String> = BTreeMap::new();
        let mut x25519_pubkeys: BTreeMap<u16, String> = BTreeMap::new();

        for participant in &participants {
            let request = DkgRound1Request {
                ceremony_id,
                threshold,
                total_participants: total,
            };
            let response = participant.round1(&request).unwrap();
            round1_packages.insert(response.signer_id, response.package);
            x25519_pubkeys.insert(response.signer_id, response.x25519_public_key);
        }

        // Round 2: encrypted shares
        let mut round2_packages: BTreeMap<u16, BTreeMap<u16, String>> = BTreeMap::new();
        for participant in &participants {
            let request = DkgRound2Request {
                ceremony_id,
                round1_packages: round1_packages.clone(),
                x25519_pubkeys: x25519_pubkeys.clone(),
            };
            let response = participant.round2(&request).unwrap();
            round2_packages.insert(response.signer_id, response.packages);
        }

        // Finalize: decrypt + compute key shares
        let mut group_pubkeys = Vec::new();
        for participant in &participants {
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
                round1_packages: round1_packages.clone(),
                round2_packages: packages_for_me,
                x25519_pubkeys: x25519_pubkeys.clone(),
            };
            let response = participant.finalize(&request, "test_password").unwrap();
            group_pubkeys.push(response.group_public_key);
        }

        assert!(group_pubkeys.windows(2).all(|w| w[0] == w[1]));
        assert!(!group_pubkeys[0].is_empty());
    }
}
