//! Transaction Signer
//!
//! Signs BTC transactions for withdrawals.
//! POC uses single-key signing; production will use MPC.

use async_trait::async_trait;
use bitcoin::{
    hashes::Hash,
    secp256k1::{self, Message, Secp256k1, SecretKey},
    sighash::{Prevouts, SighashCache, TapSighashType},
    Amount, TapTweakHash, Transaction, TxOut, Witness, XOnlyPublicKey,
};

use crate::bitcoin::frost_client::{FrostClient, PrevoutInfo, SigningContext};
use crate::redemption::builder::UnsignedTx;

/// Trait for transaction signers
#[async_trait]
pub trait TxSigner: Send + Sync {
    /// Sign a transaction
    async fn sign(&self, unsigned: &UnsignedTx) -> Result<Transaction, SignerError>;

    /// Get the signer's public key
    fn public_key(&self) -> XOnlyPublicKey;

    /// Get signer type description
    fn signer_type(&self) -> &'static str;
}

/// Single-key signer for POC
pub struct SingleKeySigner {
    secret_key: SecretKey,
    secp: Secp256k1<secp256k1::All>,
}

impl SingleKeySigner {
    /// Create from secret key bytes
    pub fn from_bytes(bytes: &[u8; 32]) -> Result<Self, SignerError> {
        let secp = Secp256k1::new();
        let secret_key = SecretKey::from_slice(bytes)
            .map_err(|e| SignerError::InvalidKey(e.to_string()))?;

        Ok(Self { secret_key, secp })
    }

    /// Create from hex string
    pub fn from_hex(hex: &str) -> Result<Self, SignerError> {
        let bytes = hex::decode(hex)
            .map_err(|e| SignerError::InvalidKey(e.to_string()))?;

        if bytes.len() != 32 {
            return Err(SignerError::InvalidKey("key must be 32 bytes".to_string()));
        }

        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        Self::from_bytes(&arr)
    }

    /// Generate a new random signer
    pub fn generate() -> Self {
        let secp = Secp256k1::new();
        let secret_key = SecretKey::new(&mut rand::thread_rng());
        Self { secret_key, secp }
    }

    /// Get secret key bytes (for backup)
    pub fn secret_bytes(&self) -> [u8; 32] {
        self.secret_key.secret_bytes()
    }

    /// Get secret key hex (for backup)
    pub fn secret_hex(&self) -> String {
        hex::encode(self.secret_bytes())
    }
}

#[async_trait]
impl TxSigner for SingleKeySigner {
    async fn sign(&self, unsigned: &UnsignedTx) -> Result<Transaction, SignerError> {
        let mut tx = unsigned.tx.clone();

        // Build prevouts for sighash
        let prevouts: Vec<TxOut> = unsigned
            .utxos
            .iter()
            .map(|utxo| {
                let script_pubkey = hex::decode(&utxo.script_pubkey)
                    .map(bitcoin::ScriptBuf::from_bytes)
                    .unwrap_or_else(|_| bitcoin::ScriptBuf::new());

                TxOut {
                    value: Amount::from_sat(utxo.amount_sats),
                    script_pubkey,
                }
            })
            .collect();

        let prevouts = Prevouts::All(&prevouts);

        // Get tweaked keypair for Taproot
        let keypair = bitcoin::secp256k1::Keypair::from_secret_key(&self.secp, &self.secret_key);
        let (internal_key, _parity) = XOnlyPublicKey::from_keypair(&keypair);

        // Tweak the keypair
        let tweak = TapTweakHash::from_key_and_tweak(internal_key, None);
        let tweaked_keypair = keypair
            .add_xonly_tweak(&self.secp, &tweak.to_scalar())
            .map_err(|e| SignerError::SigningFailed(e.to_string()))?;

        // Sign each input
        for i in 0..tx.input.len() {
            let mut sighash_cache = SighashCache::new(&tx);

            let sighash = sighash_cache
                .taproot_key_spend_signature_hash(i, &prevouts, TapSighashType::Default)
                .map_err(|e| SignerError::SigningFailed(e.to_string()))?;

            let msg = Message::from_digest_slice(sighash.as_byte_array())
                .map_err(|e| SignerError::SigningFailed(e.to_string()))?;

            let sig = self.secp.sign_schnorr(&msg, &tweaked_keypair);

            // Create witness with signature
            let signature = bitcoin::taproot::Signature {
                signature: sig,
                sighash_type: TapSighashType::Default,
            };

            tx.input[i].witness = Witness::from_slice(&[signature.to_vec()]);
        }

        Ok(tx)
    }

    fn public_key(&self) -> XOnlyPublicKey {
        let keypair = bitcoin::secp256k1::Keypair::from_secret_key(&self.secp, &self.secret_key);
        XOnlyPublicKey::from_keypair(&keypair).0
    }

    fn signer_type(&self) -> &'static str {
        "single-key"
    }
}

/// FROST threshold signer using HTTP calls to FROST signer servers
pub struct MpcSigner {
    /// FROST HTTP client
    frost_client: FrostClient,
    /// Group public key (x-only)
    pub public_key: XOnlyPublicKey,
}

impl MpcSigner {
    /// Create a new MPC signer backed by FROST threshold signing
    ///
    /// # Arguments
    /// * `frost_client` - Configured FROST HTTP client
    /// * `public_key` - The FROST group public key (x-only)
    pub fn new(frost_client: FrostClient, public_key: XOnlyPublicKey) -> Self {
        Self {
            frost_client,
            public_key,
        }
    }
}

#[async_trait]
impl TxSigner for MpcSigner {
    async fn sign(&self, unsigned: &UnsignedTx) -> Result<Transaction, SignerError> {
        let mut tx = unsigned.tx.clone();

        // Build prevouts for sighash
        let prevouts: Vec<TxOut> = unsigned
            .utxos
            .iter()
            .map(|utxo| {
                let script_pubkey = hex::decode(&utxo.script_pubkey)
                    .map(bitcoin::ScriptBuf::from_bytes)
                    .unwrap_or_else(|_| bitcoin::ScriptBuf::new());

                TxOut {
                    value: Amount::from_sat(utxo.amount_sats),
                    script_pubkey,
                }
            })
            .collect();

        let prevouts_ref = Prevouts::All(&prevouts);

        // Build signing context for signer-side verification
        let raw_tx_hex = hex::encode(bitcoin::consensus::encode::serialize(&tx));
        let context_prevouts: Vec<PrevoutInfo> = unsigned
            .utxos
            .iter()
            .map(|utxo| PrevoutInfo {
                txid: utxo.txid.clone(),
                vout: utxo.vout,
                amount_sats: utxo.amount_sats,
                script_pubkey_hex: utxo.script_pubkey.clone(),
            })
            .collect();

        // Sign each input via FROST
        for i in 0..tx.input.len() {
            let mut sighash_cache = SighashCache::new(&tx);

            let sighash = sighash_cache
                .taproot_key_spend_signature_hash(i, &prevouts_ref, TapSighashType::Default)
                .map_err(|e| SignerError::SigningFailed(e.to_string()))?;

            let sighash_bytes: [u8; 32] = sighash.to_byte_array();

            let signing_context = SigningContext {
                raw_tx_hex: raw_tx_hex.clone(),
                prevouts: context_prevouts.clone(),
                input_index: i as u32,
            };

            // Build Solana verification data if redemption metadata is available
            let solana_verification = unsigned.solana_verification.clone();

            // Call FROST signers to get threshold signature.
            // The pool address uses the RAW group key (no BIP-341 tweak),
            // so we sign without merkle_root to produce a signature for the untweaked key.
            let sig_bytes = self
                .frost_client
                .sign_sighash_tweaked(&sighash_bytes, None, Some(signing_context), None, solana_verification)
                .await
                .map_err(|e| SignerError::FrostSigningFailed(e.to_string()))?;

            let sig = bitcoin::secp256k1::schnorr::Signature::from_slice(&sig_bytes)
                .map_err(|e| SignerError::SigningFailed(format!("invalid schnorr signature: {}", e)))?;

            let signature = bitcoin::taproot::Signature {
                signature: sig,
                sighash_type: TapSighashType::Default,
            };

            tx.input[i].witness = Witness::from_slice(&[signature.to_vec()]);
        }

        Ok(tx)
    }

    fn public_key(&self) -> XOnlyPublicKey {
        self.public_key
    }

    fn signer_type(&self) -> &'static str {
        "mpc-frost"
    }
}

/// Ika dWallet signer.
///
/// Unlike `SingleKeySigner` (sync) and `MpcSigner` (HTTP request/response),
/// Ika signing is **two-phase**:
///
/// 1. The redemption pipeline submits the on-chain `complete_redemption`
///    instruction. This includes the Bitcoin sighash and triggers a CPI to
///    the Ika `approve_message` instruction, which creates a `MessageApproval`
///    PDA owned by the Ika program (program id from recon brief).
/// 2. The Ika network's mock signer (pre-alpha) asynchronously fills a `Sign`
///    PDA with the resulting Schnorr signature. `IkaSigner::sign` polls that
///    PDA on Solana RPC and assembles the witness onto the unsigned BTC tx.
///
/// **Precondition:** caller has already submitted `complete_redemption` with
/// the matching sighash before invoking `sign`. This breaks the symmetry of
/// the original `TxSigner` trait — but is unavoidable given Ika's on-chain-
/// approval-then-async-sign model. See plan §4b.5 and Task 5 for context.
pub struct IkaSigner {
    /// Solana devnet (or localnet) RPC URL — used to fetch the Sign PDA.
    pub rpc_url: String,
    /// Ika program ID (devnet: `87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY`).
    pub ika_program_id: solana_sdk::pubkey::Pubkey,
    /// Ika dWallet account address.
    pub ika_dwallet: solana_sdk::pubkey::Pubkey,
    /// dWallet's x-only secp256k1 pubkey (for `public_key()` and witness verify).
    pub xonly_pubkey: XOnlyPublicKey,
    /// Maximum total time to poll for a Sign PDA before giving up.
    pub poll_timeout: std::time::Duration,
    /// Polling interval.
    pub poll_interval: std::time::Duration,
}

impl IkaSigner {
    /// Create a new `IkaSigner` with default polling parameters.
    pub fn new(
        rpc_url: String,
        ika_program_id: solana_sdk::pubkey::Pubkey,
        ika_dwallet: solana_sdk::pubkey::Pubkey,
        xonly_pubkey: XOnlyPublicKey,
    ) -> Self {
        Self {
            rpc_url,
            ika_program_id,
            ika_dwallet,
            xonly_pubkey,
            poll_timeout: std::time::Duration::from_secs(120),
            poll_interval: std::time::Duration::from_millis(500),
        }
    }

    /// Derive the `MessageApproval` PDA for a given sighash.
    ///
    /// Seeds (per upstream voting example): `["message_approval", dwallet, sighash]`
    /// against the Ika program.
    pub fn message_approval_pda(
        &self,
        sighash: &[u8; 32],
    ) -> solana_sdk::pubkey::Pubkey {
        let (pda, _bump) = solana_sdk::pubkey::Pubkey::find_program_address(
            &[b"message_approval", self.ika_dwallet.as_ref(), sighash],
            &self.ika_program_id,
        );
        pda
    }
}

#[async_trait]
impl TxSigner for IkaSigner {
    async fn sign(&self, _unsigned: &UnsignedTx) -> Result<Transaction, SignerError> {
        // Real implementation outline (deferred to Task 7 E2E iteration):
        //
        //   1. For each input i, compute the BIP-341 taproot key-spend sighash.
        //      Identical to SingleKeySigner / MpcSigner except we don't tweak
        //      because the Ika dWallet signs the raw key-path message (the
        //      Ika program's signature_scheme = TaprootSha256 path).
        //   2. Verify that `complete_redemption` has already been submitted with
        //      this sighash (the caller's responsibility — see precondition).
        //   3. Poll Solana RPC for the Sign PDA at `["sign", dwallet, sighash]`
        //      (exact seeds confirmed live; see recon brief gotcha).
        //   4. Decode the 64-byte Schnorr signature from the Sign account data.
        //   5. Build a `bitcoin::taproot::Signature` with `TapSighashType::Default`
        //      and assemble the witness.
        //   6. Return the now-signed Transaction.
        //
        // Until this is wired (Task 5 follow-up — depends on resolving the live
        // Sign PDA layout that the recon brief deferred), this method returns
        // a clear error so call sites fail fast instead of silently producing
        // zeroed transactions.

        Err(SignerError::IkaSigningNotWired)
    }

    fn public_key(&self) -> XOnlyPublicKey {
        self.xonly_pubkey
    }

    fn signer_type(&self) -> &'static str {
        "ika-dwallet"
    }
}

/// Signer errors
#[derive(Debug, thiserror::Error)]
pub enum SignerError {
    #[error("invalid key: {0}")]
    InvalidKey(String),

    #[error("signing failed: {0}")]
    SigningFailed(String),

    #[error("FROST threshold signing failed: {0}")]
    FrostSigningFailed(String),

    #[error("FROST HTTP error: {0}")]
    FrostHttpError(String),

    #[error("MPC session error: {0}")]
    MpcSessionError(String),

    #[error("Ika signing not yet wired — Sign PDA layout pending live recon (Task 5 follow-up)")]
    IkaSigningNotWired,

    #[error("Ika RPC error: {0}")]
    IkaRpcError(String),

    #[error("Ika polling timeout: Sign PDA not populated after {0:?}")]
    IkaPollTimeout(std::time::Duration),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_key_signer() {
        let signer = SingleKeySigner::generate();

        // Check public key
        let pubkey = signer.public_key();
        assert_eq!(pubkey.serialize().len(), 32);

        // Check type
        assert_eq!(signer.signer_type(), "single-key");
    }

    #[test]
    fn test_signer_from_hex() {
        let hex = "0000000000000000000000000000000000000000000000000000000000000001";
        let signer = SingleKeySigner::from_hex(hex).unwrap();

        assert_eq!(signer.secret_hex(), hex);
    }

    // ── IkaSigner unit tests ──

    fn test_ika_signer() -> IkaSigner {
        // Synthetic but well-formed values; the test does not hit the network.
        let xonly = XOnlyPublicKey::from_slice(&[
            0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95, 0xce,
            0x87, 0x0b, 0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59, 0xf2,
            0x81, 0x5b, 0x16, 0xf8, 0x17, 0x98,
        ])
        .unwrap();
        IkaSigner::new(
            "https://api.devnet.solana.com".to_string(),
            // Ika devnet program id (recon brief)
            "87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY"
                .parse()
                .unwrap(),
            // Synthetic dwallet pubkey (any 32-byte value)
            solana_sdk::pubkey::Pubkey::new_unique(),
            xonly,
        )
    }

    #[test]
    fn ika_signer_type_label() {
        let s = test_ika_signer();
        assert_eq!(s.signer_type(), "ika-dwallet");
    }

    #[test]
    fn ika_signer_public_key_round_trips() {
        let s = test_ika_signer();
        let pk = s.public_key();
        assert_eq!(pk.serialize().len(), 32);
    }

    #[test]
    fn ika_signer_message_approval_pda_is_deterministic() {
        let s = test_ika_signer();
        let sighash = [0xab; 32];
        let pda1 = s.message_approval_pda(&sighash);
        let pda2 = s.message_approval_pda(&sighash);
        assert_eq!(pda1, pda2);
        // Different sighash → different PDA.
        let other = s.message_approval_pda(&[0xcd; 32]);
        assert_ne!(pda1, other);
    }

    #[tokio::test]
    async fn ika_signer_sign_returns_not_wired() {
        let s = test_ika_signer();
        // Build a minimally valid UnsignedTx — even an empty-input one, since
        // the stub bails before reading anything.
        let unsigned = UnsignedTx {
            tx: Transaction {
                version: bitcoin::transaction::Version::TWO,
                lock_time: bitcoin::absolute::LockTime::ZERO,
                input: vec![],
                output: vec![],
            },
            utxos: vec![],
            fee: 0,
            send_amount: 0,
            service_fee: 0,
            solana_verification: None,
        };
        let err = s.sign(&unsigned).await.expect_err("should error");
        assert!(matches!(err, SignerError::IkaSigningNotWired));
    }
}
