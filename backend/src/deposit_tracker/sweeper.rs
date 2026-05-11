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
use crate::common::crypto::sha256;
use std::str::FromStr;
use thiserror::Error;

use crate::bitcoin::frost_client::{FrostClient, PrevoutInfo, SigningContext};

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

    #[error("FROST signing failed: {0}")]
    FrostSigningFailed(String),

    #[error("No UTXO found at address")]
    NoUtxo,

    #[error("Insufficient confirmations: {0} < {1}")]
    InsufficientConfirmations(u32, u32),

    #[error("Broadcast failed: {0}")]
    BroadcastFailed(String),

    #[error("Watcher error: {0}")]
    Watcher(#[from] WatcherError),
}

/// Signing backend for the sweeper
enum SigningMode {
    /// Single-key signing (POC/testnet)
    SingleKey { secret_key: SecretKey },
    /// FROST threshold signing (production)
    Frost { frost_client: FrostClient },
}

/// UTXO Sweeper for moving deposits to pool wallet
pub struct UtxoSweeper {
    /// Secp256k1 context
    secp: Secp256k1<secp256k1::All>,
    /// Pool's internal public key
    pool_public_key: XOnlyPublicKey,
    /// Signing backend
    signing: SigningMode,
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
            pool_public_key,
            signing: SigningMode::SingleKey { secret_key: pool_secret_key },
            network: Network::Testnet,
            watcher: AddressWatcher::from_network(crate::config::Network::Devnet),
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

        let btc_network = if network == Network::Bitcoin {
            crate::config::Network::Mainnet
        } else {
            crate::config::Network::Devnet
        };
        let watcher = AddressWatcher::from_network(btc_network);

        Ok(Self {
            secp,
            pool_public_key,
            signing: SigningMode::SingleKey { secret_key: pool_secret_key },
            network,
            watcher,
            pool_receive_address,
            fee_rate: if network == Network::Bitcoin { 10 } else { 2 },
        })
    }

    /// Create sweeper using FROST threshold signing
    ///
    /// # Arguments
    /// * `frost_client` - Configured FROST HTTP client
    /// * `group_pubkey` - The FROST group public key (x-only)
    /// * `pool_receive_address` - Address to sweep funds to
    /// * `network` - Bitcoin network
    pub fn from_frost(
        frost_client: FrostClient,
        group_pubkey: XOnlyPublicKey,
        pool_receive_address: String,
        network: Network,
    ) -> Self {
        Self::from_frost_with_esplora(frost_client, group_pubkey, pool_receive_address, network, None)
    }

    /// Create sweeper using FROST threshold signing with custom Esplora URL
    pub fn from_frost_with_esplora(
        frost_client: FrostClient,
        group_pubkey: XOnlyPublicKey,
        pool_receive_address: String,
        network: Network,
        esplora_url: Option<&str>,
    ) -> Self {
        let secp = Secp256k1::new();
        let watcher = match esplora_url {
            Some(url) => AddressWatcher::new(url),
            None => {
                let btc_network = if network == Network::Bitcoin {
                    crate::config::Network::Mainnet
                } else {
                    crate::config::Network::Devnet
                };
                AddressWatcher::from_network(btc_network)
            },
        };

        Self {
            secp,
            pool_public_key: group_pubkey,
            signing: SigningMode::Frost { frost_client },
            network,
            watcher,
            pool_receive_address,
            fee_rate: if network == Network::Bitcoin { 10 } else { 2 },
        }
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
        let signed_tx = self.build_and_sign_sweep(utxo, deposit_address, &commitment_arr).await?;

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
    async fn build_and_sign_sweep(
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
        // No OP_RETURN — Solana verifies everything via VerifiedTransaction PDA
        let vsize = 10 + 58 + 43; // ~111 vbytes for 1-in 1-out P2TR
        let fee = (vsize as u64) * self.fee_rate;

        let send_amount = utxo.value.saturating_sub(fee);
        if send_amount < 546 {
            return Err(SweeperError::InvalidCommitment("amount too small after fees".to_string()));
        }

        // Build unsigned transaction (single output to pool address, no OP_RETURN)
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
            output: vec![
                TxOut {
                    value: Amount::from_sat(send_amount),
                    script_pubkey: to_address.script_pubkey(),
                },
            ],
        };

        // Sign the transaction using the tweaked key
        let signed_tx = self.sign_sweep_tx(unsigned_tx, utxo, commitment).await?;

        let tx_hex = bitcoin::consensus::encode::serialize_hex(&signed_tx);

        Ok(SignedSweepTx { tx_hex, fee })
    }

    /// Sign a sweep transaction with the tweaked key
    async fn sign_sweep_tx(
        &self,
        mut tx: Transaction,
        utxo: &Utxo,
        commitment: &[u8; 32],
    ) -> Result<Transaction, SweeperError> {
        // Compute the tweak from internal key and commitment
        // This must match the tweak used when generating the address
        let tweak_bytes = compute_tweak(&self.pool_public_key, commitment);

        // Compute tweaked public key for sighash calculation
        let scalar = secp256k1::Scalar::from_be_bytes(tweak_bytes)
            .map_err(|_| SweeperError::SigningFailed("invalid tweak scalar".to_string()))?;

        let tweaked_pubkey = self.pool_public_key
            .add_tweak(&self.secp, &scalar)
            .map_err(|_| SweeperError::SigningFailed("failed to compute tweaked pubkey".to_string()))?
            .0;

        // Create the prevout for sighash calculation
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

        let sighash_bytes = sighash.to_byte_array();

        // Sign based on the signing mode
        let sig_bytes = match &self.signing {
            SigningMode::SingleKey { secret_key } => {
                // Single-key: create tweaked keypair and sign directly
                let keypair = Keypair::from_secret_key(&self.secp, secret_key);
                let tweaked_keypair = keypair
                    .add_xonly_tweak(&self.secp, &scalar)
                    .map_err(|_| SweeperError::SigningFailed("failed to apply tweak".to_string()))?;

                let msg = Message::from_digest(sighash_bytes);
                let sig = self.secp.sign_schnorr(&msg, &tweaked_keypair);
                sig.serialize().to_vec()
            }
            SigningMode::Frost { frost_client } => {
                // Build signing context for signer-side verification
                let raw_tx_hex = hex::encode(bitcoin::consensus::encode::serialize(&tx));
                let signing_context = SigningContext {
                    raw_tx_hex,
                    prevouts: vec![PrevoutInfo {
                        txid: utxo.txid.clone(),
                        vout: utxo.vout,
                        amount_sats: utxo.value,
                        script_pubkey_hex: hex::encode(prevouts[0].script_pubkey.as_bytes()),
                    }],
                    input_index: 0,
                };

                // FROST: delegate signing to threshold signers with tweak + context
                // Pass the commitment as merkle_root so aggregate_with_tweak applies
                // BIP-341 tweaking: H_TapTweak(group_key || commitment)
                let sig = frost_client
                    .sign_sighash_tweaked(
                        &sighash_bytes,
                        Some(&tweak_bytes),
                        Some(signing_context),
                        Some(commitment),
                        None, // No Solana verification for sweeps
                    )
                    .await
                    .map_err(|e| SweeperError::FrostSigningFailed(e.to_string()))?;

                sig.to_vec()
            }
        };

        // Create witness with signature
        let witness = Witness::from_slice(&[&sig_bytes]);
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


/// Extract the 32-byte commitment from the OP_RETURN output of a raw Bitcoin transaction.
///
/// Scans all outputs for one matching `OP_RETURN OP_PUSHBYTES_32 <32 bytes>`.
/// Returns `None` if no matching output is found.
pub fn extract_commitment_from_tx(raw_tx: &[u8]) -> Option<[u8; 32]> {
    let tx: Transaction = bitcoin::consensus::encode::deserialize(raw_tx).ok()?;
    extract_commitment_from_transaction(&tx)
}

/// Extract commitment from a parsed Transaction object
pub fn extract_commitment_from_transaction(tx: &Transaction) -> Option<[u8; 32]> {
    for output in &tx.output {
        let script = output.script_pubkey.as_bytes();
        // OP_RETURN (0x6a) + OP_PUSHBYTES_32 (0x20) + 32 bytes = 34 bytes total
        if script.len() == 34 && script[0] == 0x6a && script[1] == 0x20 {
            let mut commitment = [0u8; 32];
            commitment.copy_from_slice(&script[2..34]);
            return Some(commitment);
        }
    }
    None
}

/// Size of a deposit OP_RETURN payload: ephemeralPub (32) + npk (32) = 64
pub const DEPOSIT_OP_RETURN_SIZE: usize = 64;

/// Parse a 64-byte deposit OP_RETURN from a Bitcoin script.
///
/// The script format is: OP_RETURN (0x6a) + push_opcode + 64-byte payload.
/// Returns None if the script is not a valid deposit OP_RETURN.
pub fn parse_deposit_op_return(script: &[u8]) -> Option<super::types::DepositOpReturnData> {
    // OP_RETURN (0x6a) + direct push 64 (0x40) + 64 bytes = 66 total
    if script.len() == 66 && script[0] == 0x6a && script[1] == 0x40 {
        return parse_deposit_payload(&script[2..66]);
    }
    // OP_RETURN (0x6a) + OP_PUSHDATA1 (0x4c) + length (0x40 = 64) + 64 bytes = 67 total
    if script.len() == 67 && script[0] == 0x6a && script[1] == 0x4c && script[2] == 0x40 {
        return parse_deposit_payload(&script[3..67]);
    }
    None
}

fn parse_deposit_payload(payload: &[u8]) -> Option<super::types::DepositOpReturnData> {
    if payload.len() != DEPOSIT_OP_RETURN_SIZE {
        return None;
    }
    let mut ephemeral_pub = [0u8; 32];
    let mut npk = [0u8; 32];
    ephemeral_pub.copy_from_slice(&payload[0..32]);
    npk.copy_from_slice(&payload[32..64]);
    Some(super::types::DepositOpReturnData {
        ephemeral_pub,
        npk,
    })
}

/// Verify that a P2TR output key matches the expected pool_key tweaked with a data payload.
///
/// Recomputes: expected = pool_key + H_TapTweak(pool_key || data) * G
/// For npk-based deposits, `data` is the npk (was commitment in old flow).
/// Returns true if the output key matches.
pub fn verify_deposit_output(
    output_key: &XOnlyPublicKey,
    pool_key: &XOnlyPublicKey,
    data: &[u8; 32],
) -> bool {
    let secp = Secp256k1::new();
    let tweak_bytes = compute_tweak(pool_key, data);

    let scalar = match secp256k1::Scalar::from_be_bytes(tweak_bytes) {
        Ok(s) => s,
        Err(_) => return false,
    };

    match pool_key.add_tweak(&secp, &scalar) {
        Ok((expected, _)) => *output_key == expected,
        Err(_) => false,
    }
}

/// Extract deposit OP_RETURN data from a parsed Transaction.
///
/// Scans all outputs for a 64-byte OP_RETURN deposit payload (ephemeralPub + npk).
pub fn extract_deposit_op_return_from_transaction(tx: &Transaction) -> Option<super::types::DepositOpReturnData> {
    for output in &tx.output {
        if let Some(data) = parse_deposit_op_return(output.script_pubkey.as_bytes()) {
            return Some(data);
        }
    }
    None
}

/// Compute the taproot tweak hash: H_taptweak(P || commitment)
/// Uses BIP-340 tagged hash
pub(crate) fn compute_tweak(internal_key: &XOnlyPublicKey, commitment: &[u8; 32]) -> [u8; 32] {
    let tag_hash = sha256(b"TapTweak");

    let mut hasher = Sha256::new();
    hasher.update(tag_hash);
    hasher.update(tag_hash);
    hasher.update(internal_key.serialize());
    hasher.update(commitment);
    hasher.finalize().into()
}

/// Compute a Taproot tweak using a TapLeaf script tree merkle root (BIP-341).
///
/// For deposits with a refund script, the merkle_root is the TapLeaf hash of the refund script.
/// tweak = H_TapTweak(internal_key || merkle_root)
pub fn compute_tweak_with_merkle_root(internal_key: &XOnlyPublicKey, merkle_root: &[u8; 32]) -> [u8; 32] {
    compute_tweak(internal_key, merkle_root)
}

/// Build the refund script for a deposit: <npk> OP_DROP <144> OP_CSV OP_DROP <user_pubkey> OP_CHECKSIG
pub fn build_refund_script(npk: &[u8; 32], user_pubkey: &[u8; 32]) -> Vec<u8> {
    let mut script = Vec::with_capacity(73);
    script.push(0x20); // OP_PUSHBYTES_32
    script.extend_from_slice(npk);
    script.push(0x75); // OP_DROP
    script.push(0x02); // OP_PUSHBYTES_2
    script.push(0x90); // 144 LE byte 0
    script.push(0x00); // 144 LE byte 1 (sign extension)
    script.push(0xb2); // OP_CHECKSEQUENCEVERIFY
    script.push(0x75); // OP_DROP
    script.push(0x20); // OP_PUSHBYTES_32
    script.extend_from_slice(user_pubkey);
    script.push(0xac); // OP_CHECKSIG
    script
}

/// Compute the BIP-341 TapLeaf hash: H_TapLeaf(leafVersion || compactSize(script.length) || script)
pub fn compute_tapleaf_hash(script: &[u8]) -> [u8; 32] {
    let tag_hash = sha256(b"TapLeaf");
    let mut hasher = Sha256::new();
    hasher.update(tag_hash);
    hasher.update(tag_hash);
    // leafVersion = 0xc0
    hasher.update([0xc0u8]);
    // compactSize encoding of script length
    if script.len() < 253 {
        hasher.update([script.len() as u8]);
    } else {
        hasher.update([0xfdu8]);
        hasher.update((script.len() as u16).to_le_bytes());
    }
    hasher.update(script);
    hasher.finalize().into()
}

/// Compute the Taproot tweak for a deposit with a refund script path.
///
/// 1. Builds refund script from npk + user_refund_pubkey
/// 2. Computes TapLeaf hash -> merkle root (single leaf)
/// 3. Returns H_TapTweak(internal_key || merkle_root)
pub fn compute_refund_tweak(
    internal_key: &XOnlyPublicKey,
    npk: &[u8; 32],
    user_refund_pubkey: &[u8; 32],
) -> [u8; 32] {
    let script = build_refund_script(npk, user_refund_pubkey);
    let merkle_root = compute_tapleaf_hash(&script);
    compute_tweak(internal_key, &merkle_root)
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

    fn dummy_p2tr_script() -> ScriptBuf {
        let mut bytes = vec![0x51, 0x20];
        bytes.extend_from_slice(&[0xaa; 32]);
        ScriptBuf::from_bytes(bytes)
    }

    fn op_return_script(commitment: &[u8; 32]) -> ScriptBuf {
        let mut bytes = vec![0x6a, 0x20];
        bytes.extend_from_slice(commitment);
        ScriptBuf::from_bytes(bytes)
    }

    #[test]
    fn test_op_return_commitment_roundtrip() {
        let commitment = [0x42u8; 32];

        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![],
            output: vec![
                TxOut {
                    value: Amount::from_sat(10_000),
                    script_pubkey: dummy_p2tr_script(),
                },
                TxOut {
                    value: Amount::ZERO,
                    script_pubkey: op_return_script(&commitment),
                },
            ],
        };

        // Serialize and extract from raw bytes
        let raw = bitcoin::consensus::encode::serialize(&tx);
        let extracted = extract_commitment_from_tx(&raw);
        assert_eq!(extracted, Some(commitment));
    }

    #[test]
    fn test_op_return_extraction_from_parsed_tx() {
        let commitment = [0xde; 32];

        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![],
            output: vec![
                TxOut {
                    value: Amount::ZERO,
                    script_pubkey: op_return_script(&commitment),
                },
            ],
        };

        assert_eq!(extract_commitment_from_transaction(&tx), Some(commitment));
    }

    #[test]
    fn test_op_return_extraction_none_when_missing() {
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![],
            output: vec![
                TxOut {
                    value: Amount::from_sat(10_000),
                    script_pubkey: dummy_p2tr_script(),
                },
            ],
        };

        assert_eq!(extract_commitment_from_transaction(&tx), None);
    }

    #[test]
    fn test_op_return_wrong_size_ignored() {
        // OP_RETURN with 20 bytes (not 32) — should be ignored
        let mut script_bytes = vec![0x6a, 0x14]; // OP_RETURN + PUSH 20
        script_bytes.extend_from_slice(&[0xbb; 20]);
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![],
            output: vec![
                TxOut {
                    value: Amount::ZERO,
                    script_pubkey: ScriptBuf::from_bytes(script_bytes),
                },
            ],
        };

        assert_eq!(extract_commitment_from_transaction(&tx), None);
    }

    #[test]
    fn test_parse_deposit_op_return_direct_push() {
        // OP_RETURN (0x6a) + push 64 (0x40) + 64-byte payload
        let mut script = vec![0x6a, 0x40];
        let ephemeral = [0xaa; 32];
        let npk = [0xbb; 32];
        script.extend_from_slice(&ephemeral);
        script.extend_from_slice(&npk);

        let result = parse_deposit_op_return(&script);
        assert!(result.is_some());
        let data = result.unwrap();
        assert_eq!(data.ephemeral_pub, ephemeral);
        assert_eq!(data.npk, npk);
    }

    #[test]
    fn test_parse_deposit_op_return_pushdata1() {
        // OP_RETURN (0x6a) + OP_PUSHDATA1 (0x4c) + 64 (0x40) + 64-byte payload
        let mut script = vec![0x6a, 0x4c, 0x40];
        script.extend_from_slice(&[0x11; 32]); // ephemeral
        script.extend_from_slice(&[0x22; 32]); // npk

        let result = parse_deposit_op_return(&script);
        assert!(result.is_some());
        let data = result.unwrap();
        assert_eq!(data.ephemeral_pub, [0x11; 32]);
        assert_eq!(data.npk, [0x22; 32]);
    }

    #[test]
    fn test_parse_deposit_op_return_wrong_size() {
        // 34-byte OP_RETURN (old format) should NOT match deposit format
        let mut script = vec![0x6a, 0x20];
        script.extend_from_slice(&[0xaa; 32]);
        assert!(parse_deposit_op_return(&script).is_none());
    }

    #[test]
    fn test_verify_deposit_output() {
        let secp = Secp256k1::new();
        let seed = sha256(b"test_pool_key");
        let secret = SecretKey::from_slice(&seed).unwrap();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (pool_key, _) = keypair.x_only_public_key();

        let commitment = [0x42u8; 32];
        let tweak_bytes = compute_tweak(&pool_key, &commitment);
        let scalar = secp256k1::Scalar::from_be_bytes(tweak_bytes).unwrap();
        let (expected_output, _) = pool_key.add_tweak(&secp, &scalar).unwrap();

        assert!(verify_deposit_output(&expected_output, &pool_key, &commitment));

        // Wrong commitment should fail
        let wrong_commitment = [0x43u8; 32];
        assert!(!verify_deposit_output(&expected_output, &pool_key, &wrong_commitment));
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
