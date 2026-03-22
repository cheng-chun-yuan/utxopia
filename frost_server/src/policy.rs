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
use std::collections::HashSet;
use std::sync::Mutex;

use crate::utils::recover_mutex;
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

    #[error("POLICY_SOLANA_VERIFICATION_FAILED: {0}")]
    SolanaVerificationFailed(String),

    #[error("POLICY_DUPLICATE_SIGNING: already signed redemption for {requester} nonce {nonce}")]
    DuplicateSigning {
        requester: String,
        nonce: u64,
    },

    #[error("POLICY_CROSS_VALIDATION_FAILED: {0}")]
    CrossValidationFailed(String),

    #[error("POLICY_VERIFICATION_REQUIRED: Solana verifier is configured but verification data is missing from request")]
    VerificationRequired,

    #[error("POLICY_ALREADY_PAID: BTC destination {address} already has {tx_count} transaction(s)")]
    AlreadyPaid {
        address: String,
        tx_count: usize,
    },

    #[error("POLICY_INVALID_ADDRESS: output {index} has invalid or unparseable script: {details}")]
    InvalidAddress {
        index: usize,
        details: String,
    },

    #[error("POLICY_UTXO_PDA_NOT_FOUND: UTXO {txid}:{vout} has no matching Reserved UtxoRecord PDA on Solana")]
    UtxoPdaNotFound {
        txid: String,
        vout: u32,
    },

    #[error("POLICY_UTXO_PDA_MISMATCH: {0}")]
    UtxoPdaMismatch(String),

    #[error("POLICY_UTXO_INPUTS_MISSING: Solana verifier is configured but no utxo_inputs provided in withdrawal request")]
    UtxoInputsMissing,
}

/// Tracks already-signed (requester, nonce) pairs to prevent duplicate signing.
/// Populated from audit log on startup, updated after each successful signing.
pub struct DuplicateTracker {
    signed: Mutex<HashSet<String>>,
}

impl DuplicateTracker {
    /// Create a new tracker, optionally pre-populated from audit log scan
    pub fn new(initial: HashSet<String>) -> Self {
        Self {
            signed: Mutex::new(initial),
        }
    }

    /// Check if this (requester, nonce) has already been signed
    pub fn is_signed(&self, requester: &str, nonce: u64) -> bool {
        let key = format!("{}:{}", requester, nonce);
        self.signed
            .lock()
            .unwrap_or_else(recover_mutex)
            .contains(&key)
    }

    /// Record a successful signing
    pub fn record(&self, requester: &str, nonce: u64) {
        let key = format!("{}:{}", requester, nonce);
        self.signed
            .lock()
            .unwrap_or_else(recover_mutex)
            .insert(key);
    }
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
    /// Duplicate signing tracker
    duplicate_tracker: Option<std::sync::Arc<DuplicateTracker>>,
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
            duplicate_tracker: None,
        }
    }

    /// Set the Solana on-chain verifier
    pub fn with_solana_verifier(mut self, verifier: SolanaVerifier) -> Self {
        self.solana_verifier = Some(verifier);
        self
    }

    /// Set the duplicate signing tracker
    pub fn with_duplicate_tracker(mut self, tracker: std::sync::Arc<DuplicateTracker>) -> Self {
        self.duplicate_tracker = Some(tracker);
        self
    }

    /// Get reference to duplicate tracker (for recording after successful signing)
    pub fn duplicate_tracker(&self) -> Option<&std::sync::Arc<DuplicateTracker>> {
        self.duplicate_tracker.as_ref()
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

        // 3. Validate all output addresses are parseable + check static destination whitelist
        //    For withdrawals, skip the static whitelist (cross-validation in step 8 is the real check).
        let is_withdrawal = matches!(
            request.solana_verification,
            Some(SolanaVerification::Withdrawal { .. })
        );
        self.validate_output_addresses(&tx)?;
        let destinations = if is_withdrawal {
            // Withdrawal destinations are validated by cross-validation (step 8), not static whitelist
            tx.output
                .iter()
                .filter(|o| !o.script_pubkey.is_op_return())
                .filter_map(|o| Address::from_script(&o.script_pubkey, self.network).ok())
                .map(|a| a.to_string())
                .collect()
        } else {
            self.check_destinations(&tx)?
        };

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

        // 6. Solana on-chain verification (required when verifier is configured)
        // Returns verified on-chain redemption data (amount, service_fee, btc_script)
        let verified_redemption = match (&self.solana_verifier, &request.solana_verification) {
            (Some(ref verifier), Some(ref verification)) => {
                self.verify_solana(verifier, verification).await?
            }
            (Some(_), None) => {
                // Verifier configured but no verification data — hard reject
                return Err(PolicyError::VerificationRequired);
            }
            _ => None,
        };

        // 6b. Validate PDA service_fee against on-chain PoolState fee config
        //     The PDA locks service_fee at request time; verify it's reasonable.
        if let (Some(ref verifier), Some(ref vr)) = (&self.solana_verifier, &verified_redemption) {
            match verifier.fetch_pool_fees().await {
                Ok(pool_fees) => {
                    let expected_fee = pool_fees.compute_fee(vr.amount_sats);
                    // Allow PDA fee to be <= current pool fee (fee may have changed between request and signing)
                    // But reject if PDA fee is unreasonably high (> 2x current or > 50% of amount)
                    let max_reasonable = std::cmp::max(expected_fee * 2, vr.amount_sats / 2);
                    if vr.service_fee > max_reasonable {
                        return Err(PolicyError::CrossValidationFailed(format!(
                            "PDA service_fee {} is unreasonable (pool expects ~{}, max allowed {})",
                            vr.service_fee, expected_fee, max_reasonable
                        )));
                    }
                    tracing::debug!(
                        pda_fee = vr.service_fee,
                        pool_expected_fee = expected_fee,
                        "service_fee sanity check passed"
                    );
                }
                Err(e) => {
                    tracing::warn!("failed to fetch PoolState for fee validation: {:?} — proceeding with PDA fee (authoritative)", e);
                    // Non-fatal: PDA service_fee is the user's committed fee at redemption time,
                    // PoolState is just a sanity cross-check. RPC flakiness shouldn't block signing.
                }
            }
        }

        // 6c. Verify BTC tx inputs match on-chain Reserved UtxoRecord PDAs (withdrawal only)
        //     Prevents signing transactions that spend UTXOs not tracked by the Solana program.
        if let (Some(ref verifier), Some(ref verification)) = (&self.solana_verifier, &request.solana_verification) {
            if let SolanaVerification::Withdrawal { ref utxo_inputs, .. } = verification {
                if utxo_inputs.is_empty() {
                    return Err(PolicyError::UtxoInputsMissing);
                }
                let total_verified = verifier.verify_utxo_inputs(utxo_inputs).await.map_err(|e| {
                    use crate::solana_verifier::SolanaVerifyError;
                    match e {
                        SolanaVerifyError::AccountNotFound(msg) => {
                            // Extract txid:vout from error message if possible
                            PolicyError::UtxoPdaMismatch(format!("UTXO PDA not found: {}", msg))
                        }
                        SolanaVerifyError::AmountMismatch { on_chain, expected } => {
                            PolicyError::UtxoPdaMismatch(format!(
                                "UTXO amount mismatch: on-chain {} != claimed {}",
                                on_chain, expected
                            ))
                        }
                        _ => PolicyError::UtxoPdaMismatch(format!("UTXO verification failed: {}", e)),
                    }
                })?;
                tracing::info!(
                    utxo_count = utxo_inputs.len(),
                    total_verified_sats = total_verified,
                    "UTXO inputs verified against on-chain Reserved PDAs"
                );
            }
        }

        // 7. Duplicate signing prevention (withdrawal only)
        if let Some(ref verification) = request.solana_verification {
            if let SolanaVerification::Withdrawal { ref requester, nonce, .. } = verification {
                if let Some(ref tracker) = self.duplicate_tracker {
                    if tracker.is_signed(requester, *nonce) {
                        return Err(PolicyError::DuplicateSigning {
                            requester: requester.clone(),
                            nonce: *nonce,
                        });
                    }
                }
            }
        }

        // 8. Cross-validate tx outputs match on-chain PDA data (withdrawal only)
        //    Uses service_fee from the PDA (locked at request time) to compute expected net amount.
        //    Does NOT trust backend's expected_send_amount — computes independently from on-chain data.
        if let Some(ref verification) = request.solana_verification {
            if let SolanaVerification::Withdrawal {
                ref expected_btc_address,
                ..
            } = verification
            {
                // Compute expected send amount from on-chain PDA data
                let output_check_amount = if let Some(ref vr) = verified_redemption {
                    // Use on-chain service_fee from PDA (locked at request time)
                    let net = vr.expected_send_amount();
                    tracing::info!(
                        gross = vr.amount_sats,
                        service_fee = vr.service_fee,
                        net_send = net,
                        "cross-validating tx output against on-chain PDA (amount - service_fee)"
                    );
                    net
                } else {
                    // No Solana verifier — fall back to backend's claim (dev mode only)
                    if let SolanaVerification::Withdrawal { expected_send_amount, expected_amount_sats, .. } = verification {
                        expected_send_amount.unwrap_or(*expected_amount_sats)
                    } else {
                        unreachable!()
                    }
                };

                self.cross_validate_tx_outputs(
                    &tx,
                    expected_btc_address,
                    output_check_amount,
                )?;
            }
        }

        // 9. Mempool/previous tx check — warn if destination already received payment
        //    (downgraded from hard reject to warning to support retries with corrected amounts)
        if let Some(ref verification) = request.solana_verification {
            if let SolanaVerification::Withdrawal { ref expected_btc_address, .. } = verification {
                if let Some(ref base_url) = self.esplora_url {
                    match self.check_destination_not_already_paid(
                        base_url,
                        expected_btc_address,
                    ).await {
                        Ok(()) => {}
                        Err(PolicyError::AlreadyPaid { ref address, tx_count }) => {
                            tracing::warn!(
                                address = %address,
                                tx_count = tx_count,
                                "destination already has transactions — allowing retry (on-chain PDA still valid)"
                            );
                        }
                        Err(e) => return Err(e),
                    }
                }
            }
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
            let url = format!("{}/tx/{}", base_url, prevout.txid);

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

    /// Validate that all non-OP_RETURN outputs have valid, parseable Bitcoin addresses.
    /// Rejects outputs with non-standard or unparseable scripts.
    fn validate_output_addresses(&self, tx: &Transaction) -> Result<(), PolicyError> {
        for (i, output) in tx.output.iter().enumerate() {
            if output.script_pubkey.is_op_return() {
                continue;
            }
            // Must be parseable as a valid Bitcoin address on the configured network
            Address::from_script(&output.script_pubkey, self.network).map_err(|_| {
                PolicyError::InvalidAddress {
                    index: i,
                    details: format!(
                        "script {} is not a valid address on {:?}",
                        hex::encode(output.script_pubkey.as_bytes()),
                        self.network
                    ),
                }
            })?;
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

    /// Cross-validate that the transaction outputs match the on-chain PDA's btc_script and amount.
    fn cross_validate_tx_outputs(
        &self,
        tx: &Transaction,
        expected_script_hex: &str,
        expected_amount_sats: u64,
    ) -> Result<(), PolicyError> {
        let expected_script_bytes = hex::decode(expected_script_hex).map_err(|e| {
            PolicyError::CrossValidationFailed(format!("invalid expected_btc_address hex: {}", e))
        })?;

        // Find the output that matches the expected scriptPubKey
        let matching_output = tx.output.iter().find(|out| {
            out.script_pubkey.as_bytes() == expected_script_bytes.as_slice()
        });

        let output = matching_output.ok_or_else(|| {
            PolicyError::CrossValidationFailed(format!(
                "no output matches on-chain btc_script {}",
                expected_script_hex
            ))
        })?;

        // Verify the output amount matches
        if output.value.to_sat() != expected_amount_sats {
            return Err(PolicyError::CrossValidationFailed(format!(
                "output amount {} != on-chain expected {}",
                output.value.to_sat(),
                expected_amount_sats
            )));
        }

        Ok(())
    }

    /// Check that the BTC destination address hasn't already received a payment.
    /// Queries Esplora for transactions involving the destination address.
    async fn check_destination_not_already_paid(
        &self,
        base_url: &str,
        script_hex: &str,
    ) -> Result<(), PolicyError> {
        // Convert hex scriptPubKey to a bitcoin address string for Esplora lookup
        let script_bytes = hex::decode(script_hex).map_err(|e| {
            PolicyError::CrossValidationFailed(format!("invalid script hex: {}", e))
        })?;
        let script = bitcoin::ScriptBuf::from_bytes(script_bytes);

        let address = Address::from_script(&script, self.network)
            .map(|a| a.to_string())
            .map_err(|e| {
                PolicyError::CrossValidationFailed(format!(
                    "cannot derive address from script: {}",
                    e
                ))
            })?;

        let url = format!("{}/address/{}/txs", base_url.trim_end_matches('/'), address);
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| PolicyError::EsploraError(format!("mempool check: {}", e)))?;

        if !response.status().is_success() {
            // If address not found, that's fine — no previous payments
            return Ok(());
        }

        let txs: Vec<serde_json::Value> = response
            .json()
            .await
            .map_err(|e| PolicyError::EsploraError(format!("parse tx list: {}", e)))?;

        if !txs.is_empty() {
            return Err(PolicyError::AlreadyPaid {
                address,
                tx_count: txs.len(),
            });
        }

        Ok(())
    }

    /// Verify Solana on-chain state for the given verification type.
    /// For withdrawals, returns the verified on-chain data (amount, service_fee, btc_script).
    async fn verify_solana(
        &self,
        verifier: &SolanaVerifier,
        verification: &SolanaVerification,
    ) -> Result<Option<crate::solana_verifier::VerifiedRedemption>, PolicyError> {
        match verification {
            SolanaVerification::Withdrawal {
                requester,
                nonce,
                expected_amount_sats,
                expected_btc_address,
                ..
            } => {
                let verified = verifier
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
                    })?;
                Ok(Some(verified))
            }
            SolanaVerification::Sweep { npk } => {
                verifier.verify_deposit_intent(npk).await.map_err(|e| {
                    PolicyError::SolanaVerificationFailed(format!("DepositIntent verification failed: {}", e))
                })?;
                Ok(None)
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

    #[tokio::test]
    async fn test_verification_required_when_verifier_configured() {
        // When SolanaVerifier is configured but request has no solana_verification,
        // policy should reject with VerificationRequired
        let (tx, prevout_txouts, sighash_hex) = build_test_tx();
        let raw_tx_hex = hex::encode(bitcoin::consensus::encode::serialize(&tx));

        let dest_address = Address::from_script(
            &tx.output[0].script_pubkey,
            Network::Testnet,
        )
        .unwrap()
        .to_string();

        let verifier = crate::solana_verifier::SolanaVerifier::new(
            "http://127.0.0.1:1".to_string(), // unreachable — won't be called
            "11111111111111111111111111111111",
        ).unwrap();

        let policy = SigningPolicy::new(
            None,
            vec![dest_address],
            1_000_000_000,
            100_000,
            false,
            Network::Testnet,
        ).with_solana_verifier(verifier);

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
            solana_verification: None, // <-- missing verification data
        };

        let result = policy.verify(&request).await;
        assert!(
            matches!(result, Err(PolicyError::VerificationRequired)),
            "should reject when verifier configured but no verification data: {:?}",
            result
        );
    }

    #[tokio::test]
    async fn test_no_verifier_allows_no_verification_data() {
        // When SolanaVerifier is NOT configured, missing solana_verification is fine
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
            1_000_000_000,
            100_000,
            false,
            Network::Testnet,
        );
        // No .with_solana_verifier()

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
        assert!(result.is_ok(), "should pass without verifier: {:?}", result.err());
    }

    #[test]
    fn test_duplicate_tracker_records_and_detects() {
        let tracker = DuplicateTracker::new(HashSet::new());
        assert!(!tracker.is_signed("requester-1", 42));

        tracker.record("requester-1", 42);
        assert!(tracker.is_signed("requester-1", 42));

        // Different requester or nonce should not match
        assert!(!tracker.is_signed("requester-2", 42));
        assert!(!tracker.is_signed("requester-1", 43));
    }

    #[test]
    fn test_duplicate_tracker_with_initial_signed() {
        let mut initial = HashSet::new();
        initial.insert("req-a:1".to_string());
        initial.insert("req-b:2".to_string());
        let tracker = DuplicateTracker::new(initial);
        assert!(tracker.is_signed("req-a", 1));
        assert!(tracker.is_signed("req-b", 2));
        assert!(!tracker.is_signed("req-a", 2));
    }

    #[test]
    fn test_policy_error_display() {
        let err = PolicyError::VerificationRequired;
        assert!(err.to_string().contains("POLICY_VERIFICATION_REQUIRED"));

        let err = PolicyError::ContextRequired;
        assert!(err.to_string().contains("POLICY_CONTEXT_REQUIRED"));
    }
}
