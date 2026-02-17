//! Stealth Deposit Service

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::types::{StealthData, StealthDepositRecord, StealthDepositStatus, StealthMode};

pub type SharedStealthService = Arc<RwLock<StealthDepositService>>;

#[derive(Debug, thiserror::Error)]
pub enum StealthError {
    #[error("Invalid stealth address: {0}")]
    InvalidStealthAddress(String),

    #[error("Invalid amount")]
    InvalidAmount,

    #[error("Deposit not found: {0}")]
    NotFound(String),

    #[error("Deposit expired")]
    Expired,

    #[error("Crypto error: {0}")]
    CryptoError(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

pub struct StealthDepositService {
    deposits: HashMap<String, StealthDepositRecord>,
    deposits_by_address: HashMap<String, String>,
    network: bitcoin::Network,
}

impl StealthDepositService {
    pub fn new_testnet() -> Self {
        Self {
            deposits: HashMap::new(),
            deposits_by_address: HashMap::new(),
            network: bitcoin::Network::Testnet,
        }
    }

    pub fn new_mainnet() -> Self {
        Self {
            deposits: HashMap::new(),
            deposits_by_address: HashMap::new(),
            network: bitcoin::Network::Bitcoin,
        }
    }

    pub fn prepare_deposit(
        &mut self,
        recipient_stealth_address: String,
        amount_sats: u64,
        mode: StealthMode,
    ) -> Result<StealthDepositRecord, StealthError> {
        if recipient_stealth_address.len() != 130 {
            return Err(StealthError::InvalidStealthAddress(format!(
                "Expected 130 hex chars, got {}",
                recipient_stealth_address.len()
            )));
        }

        if !recipient_stealth_address
            .chars()
            .all(|c| c.is_ascii_hexdigit())
        {
            return Err(StealthError::InvalidStealthAddress(
                "Not valid hex".to_string(),
            ));
        }

        if amount_sats == 0 {
            return Err(StealthError::InvalidAmount);
        }

        let (
            ephemeral_view_priv,
            ephemeral_view_pub,
            ephemeral_spend_priv,
            ephemeral_spend_pub,
            commitment,
            taproot_address,
        ) = self.generate_stealth_keys(&recipient_stealth_address, amount_sats)?;

        let record = StealthDepositRecord::new(
            mode,
            recipient_stealth_address,
            amount_sats,
            taproot_address.clone(),
            if mode == StealthMode::Relay {
                Some(ephemeral_view_priv.clone())
            } else {
                None
            },
            ephemeral_view_pub.clone(),
            if mode == StealthMode::Relay {
                Some(ephemeral_spend_priv.clone())
            } else {
                None
            },
            ephemeral_spend_pub.clone(),
            commitment.clone(),
        );

        if mode == StealthMode::Relay {
            self.deposits_by_address
                .insert(taproot_address, record.id.clone());
            self.deposits.insert(record.id.clone(), record.clone());
        }

        Ok(record)
    }

    pub fn create_stealth_data(&self, record: &StealthDepositRecord) -> StealthData {
        StealthData {
            version: 1,
            ephemeral_view_pub: record.ephemeral_view_pub.clone(),
            ephemeral_spend_pub: record.ephemeral_spend_pub.clone(),
            commitment: record.commitment.clone(),
            amount_sats: record.amount_sats,
            recipient_stealth_address: record.recipient_stealth_address.clone(),
        }
    }

    pub fn get_deposit(&self, id: &str) -> Option<&StealthDepositRecord> {
        self.deposits.get(id)
    }

    pub fn get_deposit_by_address(&self, address: &str) -> Option<&StealthDepositRecord> {
        self.deposits_by_address
            .get(address)
            .and_then(|id| self.deposits.get(id))
    }

    pub fn get_pending_deposits(&self) -> Vec<&StealthDepositRecord> {
        self.deposits
            .values()
            .filter(|d| {
                d.mode == StealthMode::Relay
                    && matches!(
                        d.status,
                        StealthDepositStatus::Pending
                            | StealthDepositStatus::Detected
                            | StealthDepositStatus::Confirming
                            | StealthDepositStatus::Confirmed
                    )
            })
            .collect()
    }

    pub fn update_deposit<F>(&mut self, id: &str, f: F) -> Option<()>
    where
        F: FnOnce(&mut StealthDepositRecord),
    {
        if let Some(record) = self.deposits.get_mut(id) {
            f(record);
            Some(())
        } else {
            None
        }
    }

    pub fn expire_old_deposits(&mut self) {
        let expired_ids: Vec<String> = self
            .deposits
            .iter()
            .filter(|(_, d)| d.is_expired())
            .map(|(id, _)| id.clone())
            .collect();

        for id in expired_ids {
            if let Some(record) = self.deposits.get_mut(&id) {
                record.mark_expired();
            }
        }
    }

    fn generate_stealth_keys(
        &self,
        recipient_stealth_address: &str,
        amount_sats: u64,
    ) -> Result<(String, String, String, String, String, String), StealthError> {
        use rand::RngCore;
        use sha2::{Digest, Sha256};

        let recipient_bytes = hex::decode(recipient_stealth_address)
            .map_err(|e| StealthError::InvalidStealthAddress(e.to_string()))?;

        if recipient_bytes.len() != 65 {
            return Err(StealthError::InvalidStealthAddress(
                "Expected 65 bytes".to_string(),
            ));
        }

        let _recipient_spend_pub = &recipient_bytes[0..33];
        let _recipient_view_pub = &recipient_bytes[33..65];

        let mut rng = rand::thread_rng();

        let mut ephemeral_view_priv = [0u8; 32];
        rng.fill_bytes(&mut ephemeral_view_priv);

        let ephemeral_view_pub = {
            use x25519_dalek::{PublicKey, StaticSecret};
            let secret = StaticSecret::from(ephemeral_view_priv);
            let public = PublicKey::from(&secret);
            public.as_bytes().to_vec()
        };

        let mut ephemeral_spend_priv = [0u8; 32];
        rng.fill_bytes(&mut ephemeral_spend_priv);

        let ephemeral_spend_pub = {
            use k256::elliptic_curve::sec1::ToEncodedPoint;
            use k256::SecretKey;
            let sk = SecretKey::from_slice(&ephemeral_spend_priv)
                .map_err(|e| StealthError::CryptoError(e.to_string()))?;
            let pk = sk.public_key();
            pk.to_encoded_point(true).as_bytes().to_vec()
        };

        let mut hasher = Sha256::new();
        hasher.update(&ephemeral_spend_pub);
        hasher.update(&amount_sats.to_le_bytes());
        let commitment: [u8; 32] = hasher.finalize().into();

        let taproot_address = self.derive_taproot_address(&commitment)?;

        Ok((
            hex::encode(ephemeral_view_priv),
            hex::encode(ephemeral_view_pub),
            hex::encode(ephemeral_spend_priv),
            hex::encode(ephemeral_spend_pub),
            hex::encode(commitment),
            taproot_address,
        ))
    }

    fn derive_taproot_address(&self, commitment: &[u8; 32]) -> Result<String, StealthError> {
        use bitcoin::hashes::Hash;
        use bitcoin::key::TapTweak;
        use bitcoin::secp256k1::{Secp256k1, XOnlyPublicKey};
        use bitcoin::Address;
        use sha2::{Digest, Sha256};

        let secp = Secp256k1::new();

        let internal_key_bytes: [u8; 32] = [
            0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95, 0xce, 0x87,
            0x0b, 0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59, 0xf2, 0x81, 0x5b,
            0x16, 0xf8, 0x17, 0x98,
        ];

        let internal_key = XOnlyPublicKey::from_slice(&internal_key_bytes)
            .map_err(|e| StealthError::CryptoError(format!("Invalid internal key: {}", e)))?;

        let mut hasher = Sha256::new();
        hasher.update(b"TapTweak");
        hasher.update(internal_key.serialize());
        hasher.update(commitment);
        let tweak_hash: [u8; 32] = hasher.finalize().into();

        let merkle_root = bitcoin::taproot::TapNodeHash::from_byte_array(tweak_hash);

        let tweaked = internal_key.tap_tweak(&secp, Some(merkle_root)).0;

        let address = Address::p2tr_tweaked(tweaked, self.network);

        Ok(address.to_string())
    }
}

pub fn create_stealth_service() -> SharedStealthService {
    Arc::new(RwLock::new(StealthDepositService::new_testnet()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prepare_deposit_relay_mode() {
        let mut service = StealthDepositService::new_testnet();

        let stealth_addr = "a".repeat(130);
        let result = service.prepare_deposit(stealth_addr, 100_000, StealthMode::Relay);

        assert!(result.is_ok());
        let record = result.unwrap();
        assert_eq!(record.mode, StealthMode::Relay);
        assert!(record.ephemeral_view_priv.is_some());
        assert!(record.taproot_address.starts_with("tb1p"));
    }

    #[test]
    fn test_prepare_deposit_self_custody_mode() {
        let mut service = StealthDepositService::new_testnet();

        let stealth_addr = "b".repeat(130);
        let result = service.prepare_deposit(stealth_addr, 50_000, StealthMode::SelfCustody);

        assert!(result.is_ok());
        let record = result.unwrap();
        assert_eq!(record.mode, StealthMode::SelfCustody);
        assert!(record.ephemeral_view_priv.is_none());
    }

    #[test]
    fn test_invalid_stealth_address() {
        let mut service = StealthDepositService::new_testnet();

        let result = service.prepare_deposit("too_short".to_string(), 100_000, StealthMode::Relay);
        assert!(result.is_err());
    }
}
