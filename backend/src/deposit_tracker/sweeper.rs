//! UTXO Sweeper
//!
//! Sweeps user deposits from taproot addresses to the pool-controlled wallet.
//! The sweep transaction is then used for SPV verification on Solana.
//!
//! # Flow:
//! 1. User deposits BTC to taproot address with embedded commitment
//! 2. After 6 confirmations, sweeper creates tx spending UTXO to pool wallet
//! 3. Sweep tx is signed with the tweaked key (using commitment as tweak)
//! 4. After 2 confirmations on sweep tx, it can be used for SPV verification

use bitcoin::{
    absolute::LockTime,
    hashes::Hash,
    key::{Keypair, Secp256k1},
    secp256k1::{self, Message, SecretKey},
    sighash::{Prevouts, SighashCache, TapSighashType},
    transaction::Version,
    Address, Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid,
    Witness, XOnlyPublicKey,
};
use sha2::{Digest, Sha256};
use std::str::FromStr;
use thiserror::Error;

use super::watcher::{AddressWatcher, Utxo, WatcherError};

/// Sweeper errors
#[derive(Debug, Error)]
pub enum SweeperError {
    #[error("Invalid commitment: {0}")]
    InvalidCommitment(String),

    #[error("Invalid address: {0}")]
    InvalidAddress(String),

    #[error("Invalid txid: {0}")]
    InvalidTxid(String),

    #[error("Signing failed: {0}")]
    SigningFailed(String),

    #[error("No UTXO found at address")]
    NoUtxo,

    #[error("Insufficient confirmations: {0} < {1}")]
    InsufficientConfirmations(u32, u32),

    #[error("Broadcast failed: {0}")]
    BroadcastFailed(String),

    #[error("Watcher error: {0}")]
    Watcher(#[from] WatcherError),
}

/// UTXO Sweeper for moving deposits to pool wallet
pub struct UtxoSweeper {
    /// Secp256k1 context
    secp: Secp256k1<secp256k1::All>,
    /// Pool's internal key (untweaked)
    pool_secret_key: SecretKey,
    /// Pool's internal public key
    pool_public_key: XOnlyPublicKey,
    /// Network
    network: Network,
    /// Address watcher
    watcher: AddressWatcher,
    /// Pool receive address
    pool_receive_address: String,
    /// Fee rate (sats/vbyte)
    fee_rate: u64,
}

impl UtxoSweeper {
    /// Create sweeper for testnet with POC keys
    ///
    /// # WARNING: POC ONLY - uses hardcoded keys
    pub fn new_testnet(pool_receive_address: String) -> Self {
        eprintln!("WARNING: Using POC sweeper keys - DO NOT USE WITH REAL FUNDS!");

        let secp = Secp256k1::new();

        // Same seed as PoolKeys in taproot.rs for consistency
        let seed = sha256(b"zkbtc_pool_internal_key_v1");
        let pool_secret_key =
            SecretKey::from_slice(&seed).expect("32 bytes, within curve order");

        let keypair = Keypair::from_secret_key(&secp, &pool_secret_key);
        let (pool_public_key, _parity) = keypair.x_only_public_key();

        Self {
            secp,
            pool_secret_key,
            pool_public_key,
            network: Network::Testnet,
            watcher: AddressWatcher::testnet(),
            pool_receive_address,
            fee_rate: 2, // Low fee rate for testnet
        }
    }

    /// Create sweeper from hex-encoded private key
    pub fn from_private_key(
        key_hex: &str,
        pool_receive_address: String,
        network: Network,
    ) -> Result<Self, SweeperError> {
        let key_bytes = hex::decode(key_hex)
            .map_err(|e| SweeperError::SigningFailed(format!("invalid key hex: {}", e)))?;

        let pool_secret_key = SecretKey::from_slice(&key_bytes)
            .map_err(|e| SweeperError::SigningFailed(format!("invalid secret key: {}", e)))?;

        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &pool_secret_key);
        let (pool_public_key, _parity) = keypair.x_only_public_key();

        let watcher = if network == Network::Bitcoin {
            AddressWatcher::mainnet()
        } else {
            AddressWatcher::testnet()
        };

        Ok(Self {
            secp,
            pool_secret_key,
            pool_public_key,
            network,
            watcher,
            pool_receive_address,
            fee_rate: if network == Network::Bitcoin { 10 } else { 2 },
        })
    }

    /// Get pool's internal public key (for verification)
    pub fn pool_public_key(&self) -> String {
        hex::encode(self.pool_public_key.serialize())
    }

    /// Set fee rate
    pub fn set_fee_rate(&mut self, rate: u64) {
        self.fee_rate = rate;
    }

    /// Sweep a deposit UTXO to the pool wallet
    ///
    /// # Arguments
    /// * `deposit_address` - The taproot deposit address
    /// * `commitment` - The commitment that was used to create the address (hex)
    /// * `required_confirmations` - Minimum confirmations required
    ///
    /// # Returns
    /// The sweep transaction ID
    pub async fn sweep_utxo(
        &self,
        deposit_address: &str,
        commitment: &str,
        required_confirmations: u32,
    ) -> Result<SweepResult, SweeperError> {
        // Parse commitment
        let commitment_bytes = hex::decode(commitment)
            .map_err(|e| SweeperError::InvalidCommitment(format!("invalid hex: {}", e)))?;

        if commitment_bytes.len() != 32 {
            return Err(SweeperError::InvalidCommitment(format!(
                "wrong length: {} != 32",
                commitment_bytes.len()
            )));
        }

        let mut commitment_arr = [0u8; 32];
        commitment_arr.copy_from_slice(&commitment_bytes);

        // Check address for UTXO
        let address_status = self.watcher.check_address(deposit_address).await?;

        if address_status.utxos.is_empty() {
            return Err(SweeperError::NoUtxo);
        }

        // Find the UTXO with sufficient confirmations
        let utxo = address_status
            .utxos
            .iter()
            .find(|u| u.confirmations >= required_confirmations)
            .ok_or(SweeperError::InsufficientConfirmations(
                address_status.utxos.first().map(|u| u.confirmations).unwrap_or(0),
                required_confirmations,
            ))?;

        // Build and sign sweep transaction
        let signed_tx = self.build_and_sign_sweep(utxo, deposit_address, &commitment_arr)?;

        // Broadcast
        let txid = self.watcher.broadcast_tx(&signed_tx.tx_hex).await?;

        Ok(SweepResult {
            txid,
            tx_hex: signed_tx.tx_hex,
            amount_sats: utxo.value,
            fee_sats: signed_tx.fee,
            pool_address: self.pool_receive_address.clone(),
        })
    }

    /// Build and sign a sweep transaction
    fn build_and_sign_sweep(
        &self,
        utxo: &Utxo,
        deposit_address: &str,
        commitment: &[u8; 32],
    ) -> Result<SignedSweepTx, SweeperError> {
        // Parse addresses
        let _from_address = Address::from_str(deposit_address)
            .map_err(|e| SweeperError::InvalidAddress(e.to_string()))?
            .require_network(self.network)
            .map_err(|e| SweeperError::InvalidAddress(e.to_string()))?;

        let to_address = Address::from_str(&self.pool_receive_address)
            .map_err(|e| SweeperError::InvalidAddress(format!("pool address: {}", e)))?
            .require_network(self.network)
            .map_err(|e| SweeperError::InvalidAddress(format!("pool address network: {}", e)))?;

        // Parse previous output
        let prev_txid = Txid::from_str(&utxo.txid)
            .map_err(|e| SweeperError::InvalidTxid(e.to_string()))?;

        // Estimate fee (P2TR input ~58 vbytes, P2TR output ~43 vbytes)
        let vsize = 10 + 58 + 43; // ~111 vbytes for 1-in 1-out
        let fee = (vsize as u64) * self.fee_rate;

        let send_amount = utxo.value.saturating_sub(fee);
        if send_amount < 546 {
            return Err(SweeperError::InvalidCommitment("amount too small after fees".to_string()));
        }

        // Build unsigned transaction
        let unsigned_tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: prev_txid,
                    vout: utxo.vout,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(send_amount),
                script_pubkey: to_address.script_pubkey(),
            }],
        };

        // Sign the transaction using the tweaked key
        let signed_tx = self.sign_sweep_tx(unsigned_tx, utxo, commitment)?;

        let tx_hex = bitcoin::consensus::encode::serialize_hex(&signed_tx);

        Ok(SignedSweepTx { tx_hex, fee })
    }

    /// Sign a sweep transaction with the tweaked key
    fn sign_sweep_tx(
        &self,
        mut tx: Transaction,
        utxo: &Utxo,
        commitment: &[u8; 32],
    ) -> Result<Transaction, SweeperError> {
        // Compute the tweak from internal key and commitment
        // This must match the tweak used when generating the address
        let tweak_bytes = compute_tweak(&self.pool_public_key, commitment);

        // Create the tweaked keypair
        let scalar = secp256k1::Scalar::from_be_bytes(tweak_bytes)
            .map_err(|_| SweeperError::SigningFailed("invalid tweak scalar".to_string()))?;

        let keypair = Keypair::from_secret_key(&self.secp, &self.pool_secret_key);
        let tweaked_keypair = keypair
            .add_xonly_tweak(&self.secp, &scalar)
            .map_err(|_| SweeperError::SigningFailed("failed to apply tweak".to_string()))?;

        // Create the prevout for sighash calculation
        // We need the script_pubkey of the input being spent
        let (tweaked_pubkey, _parity) = tweaked_keypair.x_only_public_key();
        let script_pubkey = ScriptBuf::new_p2tr_tweaked(
            bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(tweaked_pubkey),
        );

        let prevouts = vec![TxOut {
            value: Amount::from_sat(utxo.value),
            script_pubkey,
        }];

        // Compute sighash
        let mut sighash_cache = SighashCache::new(&tx);
        let sighash = sighash_cache
            .taproot_key_spend_signature_hash(
                0,
                &Prevouts::All(&prevouts),
                TapSighashType::Default,
            )
            .map_err(|e| SweeperError::SigningFailed(format!("sighash failed: {}", e)))?;

        // Sign with the tweaked keypair
        let msg = Message::from_digest(sighash.to_byte_array());
        let sig = self.secp.sign_schnorr(&msg, &tweaked_keypair);

        // Create witness with signature
        let witness = Witness::from_slice(&[sig.serialize().as_slice()]);
        tx.input[0].witness = witness;

        Ok(tx)
    }

    /// Check if an address has any UTXOs ready to sweep
    pub async fn check_sweep_ready(
        &self,
        deposit_address: &str,
        required_confirmations: u32,
    ) -> Result<Option<Utxo>, SweeperError> {
        let status = self.watcher.check_address(deposit_address).await?;

        Ok(status
            .utxos
            .into_iter()
            .find(|u| u.confirmations >= required_confirmations))
    }
}

/// Result of a successful sweep operation
#[derive(Debug, Clone)]
pub struct SweepResult {
    /// Transaction ID of the sweep tx
    pub txid: String,
    /// Raw transaction hex
    pub tx_hex: String,
    /// Amount swept (before fees)
    pub amount_sats: u64,
    /// Fee paid
    pub fee_sats: u64,
    /// Pool address that received the funds
    pub pool_address: String,
}

/// Signed sweep transaction
#[derive(Debug)]
struct SignedSweepTx {
    tx_hex: String,
    fee: u64,
}

/// Compute SHA256 hash
fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// Compute the taproot tweak hash: H_taptweak(P || commitment)
/// Uses BIP-340 tagged hash
fn compute_tweak(internal_key: &XOnlyPublicKey, commitment: &[u8; 32]) -> [u8; 32] {
    let tag_hash = sha256(b"TapTweak");

    let mut hasher = Sha256::new();
    hasher.update(&tag_hash);
    hasher.update(&tag_hash);
    hasher.update(&internal_key.serialize());
    hasher.update(commitment);
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sweeper_creation() {
        let sweeper =
            UtxoSweeper::new_testnet("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx".to_string());

        // Should have a valid public key
        let pubkey = sweeper.pool_public_key();
        assert_eq!(pubkey.len(), 64); // 32 bytes hex encoded
    }

    #[test]
    fn test_tweak_computation() {
        let secp = Secp256k1::new();
        let seed = sha256(b"test_seed");
        let secret_key = SecretKey::from_slice(&seed).unwrap();
        let keypair = Keypair::from_secret_key(&secp, &secret_key);
        let (pubkey, _) = keypair.x_only_public_key();

        let commitment = [0x42u8; 32];
        let tweak = compute_tweak(&pubkey, &commitment);

        // Tweak should be deterministic
        let tweak2 = compute_tweak(&pubkey, &commitment);
        assert_eq!(tweak, tweak2);

        // Different commitment should give different tweak
        let commitment2 = [0x43u8; 32];
        let tweak3 = compute_tweak(&pubkey, &commitment2);
        assert_ne!(tweak, tweak3);
    }
}
