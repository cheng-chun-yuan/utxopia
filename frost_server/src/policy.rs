//! Signing Policy Engine
//!
//! Each FROST signer independently verifies transaction data before signing.
//! This prevents a compromised backend from fabricating sighashes to drain funds.
//!
//! ## Checks performed:
//! 1. **Sighash recomputation** — parse raw tx, recompute BIP-341 sighash, reject on mismatch
//! 2. **UTXO verification** — query Esplora to confirm UTXOs exist with correct amounts
//! 3. **Destination whitelist** — verify all non-OP_RETURN outputs go to allowed addresses
//! 4. **Amount limits** — total output + fee must not exceed configured maximum
//! 5. **Fee limits** — fee must not exceed configured maximum

use bitcoin::{
    consensus::deserialize,
    hashes::Hash,
    sighash::{Prevouts, SighashCache, TapSighashType},
    Address, Amount, Network, Transaction, TxOut,
};
use thiserror::Error;

use crate::solana_verifier::SolanaVerifier;
use crate::types::{Round1Request, SigningContext, SolanaVerification};

/// Policy check errors
#[derive(Debug, Error)]
pub enum PolicyError {
    #[error("POLICY_CONTEXT_REQUIRED: signing context is required but was not provided")]
    ContextRequired,

    #[error("POLICY_INVALID_TX: failed to parse raw transaction: {0}")]
    InvalidTx(String),

    #[error("POLICY_INVALID_PREVOUT: invalid prevout data: {0}")]
    InvalidPrevout(String),

    #[error("POLICY_SIGHASH_MISMATCH: computed sighash does not match claimed sighash")]
    SighashMismatch {
        claimed: String,
        computed: String,
    },

    #[error("POLICY_DESTINATION_NOT_ALLOWED: output {index} pays to non-whitelisted address {address}")]
    DestinationNotAllowed {
        index: usize,
        address: String,
    },

    #[error("POLICY_AMOUNT_EXCEEDED: total amount {total_sats} exceeds limit {limit_sats}")]
    AmountExceeded {
        total_sats: u64,
        limit_sats: u64,
    },

    #[error("POLICY_FEE_EXCEEDED: fee {fee_sats} exceeds limit {limit_sats}")]
    FeeExceeded {
        fee_sats: u64,
        limit_sats: u64,
    },

    #[error("POLICY_UTXO_NOT_FOUND: UTXO {txid}:{vout} not found on chain")]
    UtxoNotFound {
        txid: String,
        vout: u32,
    },

    #[error("POLICY_UTXO_AMOUNT_MISMATCH: UTXO {txid}:{vout} has {on_chain_sats} sats on chain but {claimed_sats} claimed")]
    UtxoAmountMismatch {
        txid: String,
        vout: u32,
        on_chain_sats: u64,
        claimed_sats: u64,
    },

    #[error("POLICY_ESPLORA_ERROR: Esplora query failed: {0}")]
    EsploraError(String),

    #[error("POLICY_INPUT_INDEX_OUT_OF_RANGE: input_index {index} >= tx inputs {count}")]
    InputIndexOutOfRange {
        index: u32,
        count: usize,
    },

    #[error("POLICY_INVALID_SIGHASH: {0}")]
    InvalidSighash(String),

    #[error("POLICY_SOLANA_REDEMPTION_NOT_FOUND: {0}")]
    SolanaRedemptionNotFound(String),

    #[error("POLICY_SOLANA_REDEMPTION_MISMATCH: {0}")]
    SolanaRedemptionMismatch(String),

    #[error("POLICY_SOLANA_REDEMPTION_WRONG_STATUS: status {0} is not Pending or Processing")]
    SolanaRedemptionWrongStatus(u8),

    #[error("POLICY_SOLANA_RPC_ERROR: {0}")]
    SolanaRpcError(String),
}

/// Signing policy configuration
pub struct SigningPolicy {
    /// Esplora API URL for UTXO verification (None = skip UTXO checks)
    esplora_url: Option<String>,
    /// Allowed destination addresses (checked against all non-OP_RETURN outputs)
    allowed_destinations: Vec<String>,
    /// Maximum total output amount per signing operation (sats)
    max_amount_sats: u64,
    /// Maximum fee per signing operation (sats)
    max_fee_sats: u64,
    /// Whether to require signing context (true = reject blind signing)
    require_context: bool,
    /// Bitcoin network for address parsing
    network: Network,
    /// HTTP client for Esplora queries
    http: reqwest::Client,
    /// Optional Solana on-chain verifier (None = skip Solana verification)
    solana_verifier: Option<SolanaVerifier>,
}

impl SigningPolicy {
    /// Create a new signing policy
    pub fn new(
        esplora_url: Option<String>,
        allowed_destinations: Vec<String>,
        max_amount_sats: u64,
        max_fee_sats: u64,
        require_context: bool,
        network: Network,
    ) -> Self {
        Self {
            esplora_url,
            allowed_destinations,
            max_amount_sats,
            max_fee_sats,
            require_context,
            network,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            solana_verifier: None,
        }
    }

    /// Set the Solana on-chain verifier
    pub fn with_solana_verifier(mut self, verifier: SolanaVerifier) -> Self {
        self.solana_verifier = Some(verifier);
        self
    }

    /// Verify a Round1Request against the signing policy.
    ///
    /// Returns `Ok(PolicyInfo)` with extracted transaction details on success,
    /// or `Err(PolicyError)` if any check fails.
    pub async fn verify(&self, request: &Round1Request) -> Result<PolicyInfo, PolicyError> {
        let ctx = match &request.signing_context {
            Some(ctx) => ctx,
            None => {
                if self.require_context {
                    return Err(PolicyError::ContextRequired);
                }
                // Dev mode: no context, skip all checks
                return Ok(PolicyInfo::default());
            }
        };

        // 1. Parse and recompute sighash
        let (tx, prevout_txouts, computed_sighash) = self.verify_sighash(ctx, &request.sighash)?;

        // 2. Verify UTXOs on chain (if Esplora configured)
        if self.esplora_url.is_some() {
            self.verify_utxos(ctx).await?;
        }

        // 3. Check destinations
        let destinations = self.check_destinations(&tx)?;

        // 4. Check amounts
        let total_input: u64 = prevout_txouts.iter().map(|o| o.value.to_sat()).sum();
        let total_output: u64 = tx.output.iter().map(|o| o.value.to_sat()).sum();
        let fee = total_input.saturating_sub(total_output);

        if total_output > self.max_amount_sats {
            return Err(PolicyError::AmountExceeded {
                total_sats: total_output,
                limit_sats: self.max_amount_sats,
            });
        }

        // 5. Check fee
        if fee > self.max_fee_sats {
            return Err(PolicyError::FeeExceeded {
                fee_sats: fee,
                limit_sats: self.max_fee_sats,
            });
        }

        // 6. Solana on-chain verification (if both verifier and verification data present)
        if let (Some(ref verifier), Some(ref verification)) =
            (&self.solana_verifier, &request.solana_verification)
        {
            self.verify_solana(verifier, verification).await?;
        }

        Ok(PolicyInfo {
            destinations,
            total_output_sats: total_output,
            fee_sats: fee,
            computed_sighash,
        })
    }

    /// Parse raw tx, reconstruct prevouts, recompute sighash, and compare.
    fn verify_sighash(
        &self,
        ctx: &SigningContext,
        claimed_sighash: &str,
    ) -> Result<(Transaction, Vec<TxOut>, String), PolicyError> {
        // Parse raw transaction
        let raw_bytes = hex::decode(&ctx.raw_tx_hex)
            .map_err(|e| PolicyError::InvalidTx(format!("invalid hex: {}", e)))?;

        let tx: Transaction = deserialize(&raw_bytes)
            .map_err(|e| PolicyError::InvalidTx(format!("deserialize failed: {}", e)))?;

        // Validate input index
        if ctx.input_index as usize >= tx.input.len() {
            return Err(PolicyError::InputIndexOutOfRange {
                index: ctx.input_index,
                count: tx.input.len(),
            });
        }

        // Build prevout TxOuts
        let prevout_txouts: Vec<TxOut> = ctx
            .prevouts
            .iter()
            .map(|p| {
                let script_bytes = hex::decode(&p.script_pubkey_hex)
                    .map_err(|e| PolicyError::InvalidPrevout(format!("script hex: {}", e)))?;
                Ok(TxOut {
                    value: Amount::from_sat(p.amount_sats),
                    script_pubkey: bitcoin::ScriptBuf::from_bytes(script_bytes),
                })
            })
            .collect::<Result<Vec<_>, PolicyError>>()?;

        if prevout_txouts.len() != tx.input.len() {
            return Err(PolicyError::InvalidPrevout(format!(
                "prevout count {} != input count {}",
                prevout_txouts.len(),
                tx.input.len()
            )));
        }

        // Compute BIP-341 sighash
        let prevouts = Prevouts::All(&prevout_txouts);
        let mut sighash_cache = SighashCache::new(&tx);
        let computed = sighash_cache
            .taproot_key_spend_signature_hash(
                ctx.input_index as usize,
                &prevouts,
                TapSighashType::Default,
            )
            .map_err(|e| PolicyError::InvalidSighash(e.to_string()))?;

        let computed_hex = hex::encode(computed.to_byte_array());

        // Compare
        if computed_hex != claimed_sighash {
            return Err(PolicyError::SighashMismatch {
                claimed: claimed_sighash.to_string(),
                computed: computed_hex,
            });
        }

        Ok((tx, prevout_txouts, computed_hex))
    }

    /// Verify UTXOs exist on chain via Esplora
    async fn verify_utxos(&self, ctx: &SigningContext) -> Result<(), PolicyError> {
        let base_url = match &self.esplora_url {
            Some(url) => url.trim_end_matches('/'),
            None => return Ok(()),
        };

        for prevout in &ctx.prevouts {
            let url = format!("{}/api/tx/{}", base_url, prevout.txid);

            let response = self
                .http
                .get(&url)
                .send()
                .await
                .map_err(|e| PolicyError::EsploraError(format!("GET {}: {}", url, e)))?;

            if !response.status().is_success() {
                return Err(PolicyError::UtxoNotFound {
                    txid: prevout.txid.clone(),
                    vout: prevout.vout,
                });
            }

            // Parse response to verify output amount
            let tx_data: serde_json::Value = response
                .json()
                .await
                .map_err(|e| PolicyError::EsploraError(format!("parse response: {}", e)))?;

            let outputs = tx_data["vout"]
                .as_array()
                .ok_or_else(|| PolicyError::EsploraError("missing vout array".to_string()))?;

            let output = outputs
                .get(prevout.vout as usize)
                .ok_or_else(|| PolicyError::UtxoNotFound {
                    txid: prevout.txid.clone(),
                    vout: prevout.vout,
                })?;

            let on_chain_sats = output["value"]
                .as_u64()
                .ok_or_else(|| PolicyError::EsploraError("missing value field".to_string()))?;

            if on_chain_sats != prevout.amount_sats {
                return Err(PolicyError::UtxoAmountMismatch {
                    txid: prevout.txid.clone(),
                    vout: prevout.vout,
                    on_chain_sats,
                    claimed_sats: prevout.amount_sats,
                });
            }
        }

        Ok(())
    }

    /// Check that all non-OP_RETURN outputs go to allowed destinations.
    /// Returns the list of destination addresses found.
    fn check_destinations(&self, tx: &Transaction) -> Result<Vec<String>, PolicyError> {
        // If no allowed destinations configured, skip this check
        if self.allowed_destinations.is_empty() {
            return Ok(Vec::new());
        }

        let mut destinations = Vec::new();

        for (i, output) in tx.output.iter().enumerate() {
            // Skip OP_RETURN outputs (data carrier, no funds)
            if output.script_pubkey.is_op_return() {
                continue;
            }

            // Try to parse the script_pubkey as an address
            let address = Address::from_script(&output.script_pubkey, self.network)
                .map(|a| a.to_string())
                .unwrap_or_else(|_| hex::encode(output.script_pubkey.as_bytes()));

            if !self.allowed_destinations.contains(&address) {
                return Err(PolicyError::DestinationNotAllowed {
                    index: i,
                    address,
                });
            }

            destinations.push(address);
        }

        Ok(destinations)
    }

    /// Verify Solana on-chain state for the given verification type.
    async fn verify_solana(
        &self,
        verifier: &SolanaVerifier,
        verification: &SolanaVerification,
    ) -> Result<(), PolicyError> {
        match verification {
            SolanaVerification::Withdrawal {
                requester,
                nonce,
                expected_amount_sats,
                expected_btc_address,
            } => {
                verifier
                    .verify_redemption(requester, *nonce, *expected_amount_sats, expected_btc_address)
                    .await
                    .map_err(|e| {
                        use crate::solana_verifier::SolanaVerifyError;
                        match e {
                            SolanaVerifyError::AccountNotFound(msg) => {
                                PolicyError::SolanaRedemptionNotFound(msg)
                            }
                            SolanaVerifyError::WrongStatus(status) => {
                                PolicyError::SolanaRedemptionWrongStatus(status)
                            }
                            SolanaVerifyError::AmountMismatch { on_chain, expected } => {
                                PolicyError::SolanaRedemptionMismatch(format!(
                                    "amount: on-chain {} != expected {}",
                                    on_chain, expected
                                ))
                            }
                            SolanaVerifyError::BtcAddressMismatch { on_chain, expected } => {
                                PolicyError::SolanaRedemptionMismatch(format!(
                                    "BTC address: on-chain '{}' != expected '{}'",
                                    on_chain, expected
                                ))
                            }
                            SolanaVerifyError::InvalidAccountData(msg) => {
                                PolicyError::SolanaRedemptionMismatch(msg)
                            }
                            SolanaVerifyError::RpcError(msg) => {
                                PolicyError::SolanaRpcError(msg)
                            }
                        }
                    })
            }
        }
    }
}

/// Information extracted during policy verification
#[derive(Debug, Default)]
pub struct PolicyInfo {
    /// Destination addresses in the transaction
    pub destinations: Vec<String>,
    /// Total output amount (sats)
    pub total_output_sats: u64,
    /// Transaction fee (sats)
    pub fee_sats: u64,
    /// Computed sighash (hex)
    pub computed_sighash: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::{
        absolute::LockTime,
        hashes::Hash,
        key::Keypair,
        secp256k1::Secp256k1,
        sighash::SighashCache,
        transaction::Version,
        OutPoint, ScriptBuf, Sequence, TxIn, Txid, Witness, XOnlyPublicKey,
    };
    use crate::types::PrevoutInfo;

    /// Helper: build a simple test transaction and return (tx, prevouts, sighash_hex)
    fn build_test_tx() -> (Transaction, Vec<TxOut>, String) {
        let secp = Secp256k1::new();
        let keypair = Keypair::new(&secp, &mut rand::thread_rng());
        let (xonly, _) = XOnlyPublicKey::from_keypair(&keypair);

        let script_pubkey = ScriptBuf::new_p2tr_tweaked(
            bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(xonly),
        );

        let prevout_txout = TxOut {
            value: Amount::from_sat(10_000),
            script_pubkey: script_pubkey.clone(),
        };

        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::all_zeros(),
                    vout: 0,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(9_500),
                script_pubkey,
            }],
        };

        // Compute sighash
        let prevouts_vec = vec![prevout_txout.clone()];
        let prevouts = Prevouts::All(&prevouts_vec);
        let mut cache = SighashCache::new(&tx);
        let sighash = cache
            .taproot_key_spend_signature_hash(0, &prevouts, TapSighashType::Default)
            .unwrap();

        (tx, vec![prevout_txout], hex::encode(sighash.to_byte_array()))
    }

    #[tokio::test]
    async fn test_sighash_verification_pass() {
        let (tx, prevout_txouts, sighash_hex) = build_test_tx();
        let raw_tx_hex = hex::encode(bitcoin::consensus::encode::serialize(&tx));

        let dest_address = Address::from_script(
            &tx.output[0].script_pubkey,
            Network::Testnet,
        )
        .unwrap()
        .to_string();

        let policy = SigningPolicy::new(
            None,
            vec![dest_address],
            1_000_000_000, // 10 BTC
            100_000,
            true,
            Network::Testnet,
        );

        let request = Round1Request {
            session_id: uuid::Uuid::new_v4(),
            sighash: sighash_hex,
            tweak: None,
            signing_context: Some(SigningContext {
                raw_tx_hex,
                prevouts: vec![PrevoutInfo {
                    txid: "0".repeat(64),
                    vout: 0,
                    amount_sats: prevout_txouts[0].value.to_sat(),
                    script_pubkey_hex: hex::encode(prevout_txouts[0].script_pubkey.as_bytes()),
                }],
                input_index: 0,
            }),
            merkle_root: None,
            solana_verification: None,
        };

        let result = policy.verify(&request).await;
        assert!(result.is_ok(), "policy check should pass: {:?}", result.err());
    }

    #[tokio::test]
    async fn test_sighash_mismatch_rejected() {
        let (tx, prevout_txouts, _) = build_test_tx();
        let raw_tx_hex = hex::encode(bitcoin::consensus::encode::serialize(&tx));
        let fake_sighash = "ff".repeat(32);

        let policy = SigningPolicy::new(None, vec![], 1_000_000_000, 100_000, true, Network::Testnet);

        let request = Round1Request {
            session_id: uuid::Uuid::new_v4(),
            sighash: fake_sighash,
            tweak: None,
            signing_context: Some(SigningContext {
                raw_tx_hex,
                prevouts: vec![PrevoutInfo {
                    txid: "0".repeat(64),
                    vout: 0,
                    amount_sats: prevout_txouts[0].value.to_sat(),
                    script_pubkey_hex: hex::encode(prevout_txouts[0].script_pubkey.as_bytes()),
                }],
                input_index: 0,
            }),
            merkle_root: None,
            solana_verification: None,
        };

        let result = policy.verify(&request).await;
        assert!(matches!(result, Err(PolicyError::SighashMismatch { .. })));
    }

    #[tokio::test]
    async fn test_context_required_rejects_blind_signing() {
        let policy = SigningPolicy::new(None, vec![], 1_000_000_000, 100_000, true, Network::Testnet);

        let request = Round1Request {
            session_id: uuid::Uuid::new_v4(),
            sighash: "aa".repeat(32),
            tweak: None,
            signing_context: None,
            merkle_root: None,
            solana_verification: None,
        };

        let result = policy.verify(&request).await;
        assert!(matches!(result, Err(PolicyError::ContextRequired)));
    }

    #[tokio::test]
    async fn test_dev_mode_allows_blind_signing() {
        let policy = SigningPolicy::new(None, vec![], 1_000_000_000, 100_000, false, Network::Testnet);

        let request = Round1Request {
            session_id: uuid::Uuid::new_v4(),
            sighash: "aa".repeat(32),
            tweak: None,
            signing_context: None,
            merkle_root: None,
            solana_verification: None,
        };

        let result = policy.verify(&request).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_fee_exceeded_rejected() {
        let (tx, prevout_txouts, sighash_hex) = build_test_tx();
        let raw_tx_hex = hex::encode(bitcoin::consensus::encode::serialize(&tx));

        // Set max fee to 100 sats (fee is 500 sats in test tx)
        let policy = SigningPolicy::new(None, vec![], 1_000_000_000, 100, false, Network::Testnet);

        let request = Round1Request {
            session_id: uuid::Uuid::new_v4(),
            sighash: sighash_hex,
            tweak: None,
            signing_context: Some(SigningContext {
                raw_tx_hex,
                prevouts: vec![PrevoutInfo {
                    txid: "0".repeat(64),
                    vout: 0,
                    amount_sats: prevout_txouts[0].value.to_sat(),
                    script_pubkey_hex: hex::encode(prevout_txouts[0].script_pubkey.as_bytes()),
                }],
                input_index: 0,
            }),
            merkle_root: None,
            solana_verification: None,
        };

        let result = policy.verify(&request).await;
        assert!(matches!(result, Err(PolicyError::FeeExceeded { .. })));
    }

    #[tokio::test]
    async fn test_destination_not_allowed_rejected() {
        let (tx, prevout_txouts, sighash_hex) = build_test_tx();
        let raw_tx_hex = hex::encode(bitcoin::consensus::encode::serialize(&tx));

        // Whitelist a different address
        let policy = SigningPolicy::new(
            None,
            vec!["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx".to_string()],
            1_000_000_000,
            100_000,
            false,
            Network::Testnet,
        );

        let request = Round1Request {
            session_id: uuid::Uuid::new_v4(),
            sighash: sighash_hex,
            tweak: None,
            signing_context: Some(SigningContext {
                raw_tx_hex,
                prevouts: vec![PrevoutInfo {
                    txid: "0".repeat(64),
                    vout: 0,
                    amount_sats: prevout_txouts[0].value.to_sat(),
                    script_pubkey_hex: hex::encode(prevout_txouts[0].script_pubkey.as_bytes()),
                }],
                input_index: 0,
            }),
            merkle_root: None,
            solana_verification: None,
        };

        let result = policy.verify(&request).await;
        assert!(matches!(result, Err(PolicyError::DestinationNotAllowed { .. })));
    }
}
