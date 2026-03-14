//! Redemption Service
//!
//! Main service that scans on-chain RedemptionRequest PDAs and triggers BTC withdrawals.
//! Uses a 3-phase tick loop:
//!   Phase 1: Scan PDAs
//!   Phase 2: Process new (Pending) PDAs
//!   Phase 3: Try to complete (Processing) PDAs

use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::{Notify, RwLock};
use solana_sdk::signature::Signer as SolanaSigner;

use crate::bitcoin::client::EsploraClient;
use crate::deposit_tracker::header_relayer::HeaderRelayer;
use crate::redemption::builder::TxBuilder;
use crate::redemption::queue::WithdrawalQueue;
use crate::redemption::signer::{SingleKeySigner, TxSigner};
use crate::redemption::tracking::TrackingStore;
use crate::redemption::types::*;
use crate::redemption::watcher::RedemptionScanner;
use crate::redemption::ws_redemption::RedemptionWsListener;
use crate::solana::client::SolClient;

/// Get current Unix timestamp in seconds.
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Convert raw BTC scriptPubKey bytes to a bech32 address string.
fn script_to_address(script: &[u8], network: bitcoin::Network) -> Result<String, String> {
    let script_buf = bitcoin::ScriptBuf::from_bytes(script.to_vec());
    bitcoin::Address::from_script(&script_buf, network)
        .map(|addr| addr.to_string())
        .map_err(|e| format!("script_to_address: {}", e))
}

/// Redemption service
pub struct RedemptionService {
    /// Configuration
    config: RedemptionConfig,

    /// PDA scanner
    scanner: RedemptionScanner,

    /// Local tracking store (PDA -> BTC txid mapping)
    tracking: TrackingStore,

    /// Solana client (shared with scanner)
    sol_client: Arc<SolClient>,

    /// WebSocket notify handle — poked when a PDA change is detected
    ws_notify: Arc<Notify>,

    /// Withdrawal queue (kept for submit_withdrawal / get_all_requests compatibility)
    queue: WithdrawalQueue,

    /// Transaction builder (behind RwLock for periodic fee refresh from chain)
    builder: RwLock<TxBuilder>,

    /// Transaction signer
    signer: Arc<dyn TxSigner>,

    /// Esplora client for broadcasting and confirmation checks
    esplora: EsploraClient,

    /// Pool UTXOs (simplified for POC)
    pool_utxos: Arc<RwLock<Vec<PoolUtxo>>>,

    /// Statistics
    stats: Arc<RwLock<RedemptionStats>>,

    /// Running flag
    running: Arc<RwLock<bool>>,

    /// Header relayer for on-demand block header sync (optional, shared with deposit tracker)
    header_relayer: Option<Arc<HeaderRelayer>>,
}

impl RedemptionService {
    /// Create a new redemption service with any TxSigner implementation
    pub fn new_with_signer(
        mut config: RedemptionConfig,
        signer: impl TxSigner + 'static,
        sol_client: SolClient,
    ) -> Self {
        let scanner = RedemptionScanner::new(SolClient::new_like(&sol_client));
        let sol_client = Arc::new(sol_client);
        let tracking = TrackingStore::new("redemption_tracking.json");
        let ws_notify = Arc::new(Notify::new());

        let mut builder = TxBuilder::new_testnet();
        // Fetch all pool config from on-chain PoolState (source of truth)
        match sol_client.fetch_pool_config() {
            Ok(pool_cfg) => {
                println!(
                    "[redemption] Loaded on-chain PoolState: fee_bps={}, fee_base={}, min={}, max={}",
                    pool_cfg.service_fee_bps, pool_cfg.service_fee_base,
                    pool_cfg.min_deposit, pool_cfg.max_deposit,
                );
                builder.set_service_fee_model(pool_cfg.service_fee_bps, pool_cfg.service_fee_base);
                config.min_withdrawal = pool_cfg.min_deposit;
                config.max_withdrawal = pool_cfg.max_deposit;
            }
            Err(e) => {
                eprintln!("[redemption] Warning: failed to fetch on-chain pool config ({:?}), using fallback defaults", e);
                builder.set_service_fee_model(config.service_fee_bps, config.service_fee_base);
            }
        }

        // Auto-init header relayer if env vars are set
        let header_relayer = Self::try_create_header_relayer();

        Self {
            scanner,
            tracking,
            sol_client,
            ws_notify,
            queue: WithdrawalQueue::default(),
            builder: RwLock::new(builder),
            signer: Arc::new(signer),
            esplora: EsploraClient::from_network(crate::config::Network::Devnet),
            pool_utxos: Arc::new(RwLock::new(Vec::new())),
            stats: Arc::new(RwLock::new(RedemptionStats::default())),
            running: Arc::new(RwLock::new(false)),
            header_relayer,
            config,
        }
    }

    /// Set the header relayer (shared with deposit tracker for on-demand sync)
    pub fn set_header_relayer(&mut self, relayer: Arc<HeaderRelayer>) {
        self.header_relayer = Some(relayer);
    }

    /// Try to create a header relayer from environment variables.
    fn try_create_header_relayer() -> Option<Arc<HeaderRelayer>> {
        use crate::common::env::env_bool;

        if !env_bool("HEADER_RELAY_ENABLED", false) {
            return None;
        }

        let relayer_keypair_val = std::env::var("RELAYER_KEYPAIR").ok()?;
        if relayer_keypair_val.is_empty() {
            return None;
        }

        let keypair = crate::common::keypair::load_keypair(&relayer_keypair_val).ok()?;

        let solana_rpc = std::env::var("AEGIS_SOLANA_RPC")
            .or_else(|_| std::env::var("SOLANA_RPC_URL"))
            .unwrap_or_else(|_| "https://api.devnet.solana.com".to_string());
        let esplora_url = std::env::var("ESPLORA_URL")
            .unwrap_or_else(|_| "https://mempool.space/testnet4/api".to_string());
        let btc_lc_pid = std::env::var("BTC_LIGHT_CLIENT_PROGRAM_ID")
            .unwrap_or_else(|_| "Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq".to_string());
        let batch_size: u8 = std::env::var("HEADER_BATCH_SIZE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5);

        match HeaderRelayer::new(&solana_rpc, &esplora_url, &btc_lc_pid, keypair, batch_size) {
            Ok(r) => {
                println!("[redemption] Header relayer configured for on-demand sync");
                Some(Arc::new(r))
            }
            Err(e) => {
                eprintln!("[redemption] Failed to create header relayer: {}", e);
                None
            }
        }
    }

    /// Create with generated signer (for testing)
    pub fn new_testnet() -> Self {
        let signer = SingleKeySigner::generate();
        let sol_client = SolClient::new(crate::solana::client::SolConfig::default());
        Self::new_with_signer(RedemptionConfig::default(), signer, sol_client)
    }

    /// Submit a withdrawal request
    pub async fn submit_withdrawal(
        &self,
        solana_burn_tx: String,
        user_solana_address: String,
        amount_sats: u64,
        btc_address: String,
        redemption_nonce: Option<u64>,
    ) -> Result<String, ServiceError> {
        // Validate amount
        if amount_sats < self.config.min_withdrawal {
            return Err(ServiceError::AmountTooSmall {
                min: self.config.min_withdrawal,
                got: amount_sats,
            });
        }

        if amount_sats > self.config.max_withdrawal {
            return Err(ServiceError::AmountTooLarge {
                max: self.config.max_withdrawal,
                got: amount_sats,
            });
        }

        // Validate BTC address
        self.builder.read().await
            .validate_address(&btc_address)
            .map_err(|e| ServiceError::InvalidAddress(e.to_string()))?;

        // Create request
        let mut request = WithdrawalRequest::new(
            solana_burn_tx,
            user_solana_address,
            amount_sats,
            btc_address,
        );
        request.redemption_nonce = redemption_nonce;

        let id = request.id.clone();

        // Add to queue
        self.queue
            .add(request)
            .await
            .map_err(|e| ServiceError::QueueError(e.to_string()))?;

        // Update stats
        let mut stats = self.stats.write().await;
        stats.total_requests += 1;
        stats.pending += 1;

        Ok(id)
    }

    /// Add pool UTXOs (for spending)
    pub async fn add_pool_utxo(&self, utxo: PoolUtxo) {
        self.pool_utxos.write().await.push(utxo);
    }

    // ========================================================================
    // 3-Phase Tick Pipeline
    // ========================================================================

    /// Refresh pool UTXOs from Esplora
    async fn refresh_pool_utxos(&self) -> Result<(), ServiceError> {
        if self.config.pool_address.is_empty() {
            return Ok(());
        }

        let utxos_info = self
            .esplora
            .get_address_utxos(&self.config.pool_address)
            .await
            .map_err(|e| ServiceError::BuildError(format!("fetch UTXOs: {}", e)))?;

        // Derive script_pubkey from pool address
        let address = bitcoin::Address::from_str(&self.config.pool_address)
            .map_err(|e| ServiceError::BuildError(format!("invalid pool address: {}", e)))?
            .assume_checked();
        let script_hex = hex::encode(address.script_pubkey().as_bytes());

        let pool_utxos: Vec<PoolUtxo> = utxos_info
            .into_iter()
            .filter(|u| u.confirmations > 0) // only confirmed UTXOs
            .map(|u| PoolUtxo {
                txid: u.txid,
                vout: u.vout,
                amount_sats: u.value,
                script_pubkey: script_hex.clone(),
            })
            .collect();

        let count = pool_utxos.len();
        let total: u64 = pool_utxos.iter().map(|u| u.amount_sats).sum();
        *self.pool_utxos.write().await = pool_utxos;

        if count > 0 {
            println!(
                "[redemption] Refreshed pool UTXOs: {} UTXOs, {} sats total",
                count, total
            );
        }

        Ok(())
    }

    /// Run one tick of the 3-phase pipeline.
    pub async fn tick(&self) -> Result<TickResult, ServiceError> {
        let mut result = TickResult::default();

        // Phase 0a: Refresh pool config from on-chain PoolState (fees, limits)
        match self.sol_client.fetch_pool_config() {
            Ok(pool_cfg) => {
                self.builder.write().await.set_service_fee_model(
                    pool_cfg.service_fee_bps,
                    pool_cfg.service_fee_base,
                );
                // min/max are in self.config which is not mutable here;
                // they were set at startup and rarely change
            }
            Err(e) => {
                eprintln!("[tick] Warning: failed to refresh on-chain pool config: {:?}", e);
            }
        }

        // Phase 0b: Refresh pool UTXOs from Esplora
        if let Err(e) = self.refresh_pool_utxos().await {
            eprintln!("[tick] Warning: failed to refresh UTXOs: {}", e);
        }

        // Phase 1: Scan all RedemptionRequest PDAs
        let scan = self
            .scanner
            .scan()
            .map_err(|e| ServiceError::WatcherError(e.to_string()))?;

        result.pending_pdas = scan.pending.len();

        // Reconcile tracking store — remove entries for PDAs that no longer exist on-chain
        let active_addrs = scan.all_addresses();
        self.tracking.reconcile(&active_addrs).await;

        // Phase 2: Process new Pending PDAs (or retry previously failed ones)
        for pda in &scan.pending {
            if let Some(entry) = self.tracking.get(&pda.pda_address).await {
                if entry.local_status != LocalRedemptionStatus::Failed {
                    continue; // already being handled
                }
                // Failed entries can be retried — remove stale tracking
                self.tracking.remove(&pda.pda_address).await;
            }
            match self.process_new_redemption(pda).await {
                Ok(_) => result.withdrawals_processed += 1,
                Err(e) => {
                    eprintln!(
                        "[tick] Error processing PDA {}: {}",
                        &pda.pda_address[..8],
                        e
                    );
                }
            }
        }

        // Phase 3: Try to complete Processing PDAs that have a btc_txid in tracking,
        //          or retry BTC tx build for Processing PDAs that failed locally.
        for pda in &scan.processing {
            // Check if this Processing PDA failed locally (no btc_txid) — retry BTC build
            if let Some(entry) = self.tracking.get(&pda.pda_address).await {
                if entry.local_status == LocalRedemptionStatus::Failed && entry.btc_txid.is_none() {
                    self.tracking.remove(&pda.pda_address).await;
                    match self.build_sign_broadcast(pda).await {
                        Ok(_) => result.withdrawals_processed += 1,
                        Err(e) => {
                            eprintln!(
                                "[tick] Retry failed for Processing PDA {}: {}",
                                &pda.pda_address[..8],
                                e
                            );
                        }
                    }
                    continue;
                }
            } else {
                // Processing on-chain but not tracked locally (e.g., after redeploy).
                // Try to recover an existing BTC tx before re-signing.
                let btc_address = match script_to_address(&pda.btc_script, bitcoin::Network::Testnet) {
                    Ok(addr) => addr,
                    Err(e) => {
                        eprintln!("[tick] Cannot parse btc_script for PDA {}: {}", &pda.pda_address[..8], e);
                        continue;
                    }
                };

                // Check if a BTC tx was already sent to this destination
                match self.esplora.get_address_txids(&btc_address).await {
                    Ok(txids) if !txids.is_empty() => {
                        // Found existing tx(s) — recover the most recent one
                        let recovered_txid = txids[0].clone();
                        println!(
                            "[tick] Recovered existing BTC tx {} for untracked PDA {} (dest: {})",
                            &recovered_txid[..12], &pda.pda_address[..8], &btc_address
                        );
                        let entry = RedemptionTracking {
                            pda_address: pda.pda_address.clone(),
                            btc_txid: Some(recovered_txid),
                            local_status: LocalRedemptionStatus::AwaitingConfirmation,
                            retry_count: 0,
                            created_at: now_secs(),
                            last_updated: now_secs(),
                            error: None,
                            verified_tx_pda: None,
                            buffer_pubkey: None,
                            tx_size: None,
                            requester: Some(pda.requester.clone()),
                            amount_sats: Some(pda.amount_sats),
                            btc_script: Some(hex::encode(&pda.btc_script)),
                            request_id: Some(pda.request_id),
                            simulated: false,
                        };
                        self.tracking.upsert(entry).await;
                    }
                    _ => {
                        // No existing tx found — need to sign fresh
                        println!(
                            "[tick] No existing BTC tx for untracked PDA {}, building fresh",
                            &pda.pda_address[..8]
                        );
                        match self.build_sign_broadcast(pda).await {
                            Ok(_) => result.withdrawals_processed += 1,
                            Err(e) => {
                                eprintln!(
                                    "[tick] Error building tx for untracked Processing PDA {}: {}",
                                    &pda.pda_address[..8],
                                    e
                                );
                            }
                        }
                    }
                }
                continue;
            }

            match self.try_complete_redemption(pda).await {
                Ok(true) => result.withdrawals_completed += 1,
                Ok(false) => {} // not ready yet
                Err(e) => {
                    eprintln!(
                        "[tick] Error completing PDA {}: {}",
                        &pda.pda_address[..8],
                        e
                    );
                }
            }
        }

        Ok(result)
    }

    /// Phase 2: Process a newly-discovered Pending PDA.
    ///
    /// 1. send_mark_processing on-chain
    /// 2. Build, sign, broadcast BTC tx
    async fn process_new_redemption(
        &self,
        pda: &ParsedRedemption,
    ) -> Result<ProcessResult, ServiceError> {
        let pda_pubkey = pda
            .pda_address
            .parse::<solana_sdk::pubkey::Pubkey>()
            .map_err(|e| ServiceError::BuildError(format!("invalid PDA pubkey: {}", e)))?;

        // Step 1: Mark processing on-chain (transitions Pending -> Processing)
        self.sol_client
            .send_mark_processing(&pda_pubkey)
            .await
            .map_err(|e| ServiceError::BuildError(format!("send_mark_processing: {}", e)))?;

        println!(
            "[redemption] Marked PDA {} as Processing (amount={})",
            &pda.pda_address[..8],
            pda.amount_sats
        );

        // Step 2: Build, sign, broadcast BTC transaction
        self.build_sign_broadcast(pda).await
    }

    /// Build, sign, and broadcast a BTC transaction for a PDA already marked Processing.
    ///
    /// This is used both for newly-processed PDAs (after mark_processing) and for
    /// retrying Processing PDAs that failed the BTC tx step.
    async fn build_sign_broadcast(
        &self,
        pda: &ParsedRedemption,
    ) -> Result<ProcessResult, ServiceError> {
        // Convert PDA data to a WithdrawalRequest
        let btc_address = script_to_address(&pda.btc_script, bitcoin::Network::Testnet)
            .map_err(|e| ServiceError::InvalidAddress(e))?;

        let mut request = WithdrawalRequest::new(
            String::new(),
            pda.requester.clone(),
            pda.amount_sats,
            btc_address,
        );
        request.redemption_nonce = Some(pda.request_id);
        request.pda_service_fee = Some(pda.service_fee);

        // Get UTXOs and build tx
        let utxos = self.pool_utxos.read().await.clone();
        if utxos.is_empty() {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            let entry = RedemptionTracking {
                pda_address: pda.pda_address.clone(),
                btc_txid: None,
                local_status: LocalRedemptionStatus::Failed,
                retry_count: 0,
                created_at: now,
                last_updated: now,
                error: Some("no UTXOs available".to_string()),
                verified_tx_pda: None,
                buffer_pubkey: None,
                tx_size: None,
                requester: Some(pda.requester.clone()),
                amount_sats: Some(pda.amount_sats),
                btc_script: Some(hex::encode(&pda.btc_script)),
                request_id: Some(pda.request_id),
                simulated: false,
            };
            self.tracking.upsert(entry).await;
            return Err(ServiceError::NoUtxos);
        }

        let mut unsigned = self
            .builder.read().await
            .build_withdrawal(&request, &utxos)
            .map_err(|e| ServiceError::BuildError(e.to_string()))?;

        // Attach Solana verification data for FROST signers
        if let Some(nonce) = request.redemption_nonce {
            // FROST policy expects hex scriptPubKey, not bech32 address
            let btc_script_hex = {
                let addr = bitcoin::Address::from_str(&request.btc_address)
                    .map_err(|e| ServiceError::InvalidAddress(format!("parse address: {}", e)))?
                    .assume_checked();
                hex::encode(addr.script_pubkey().as_bytes())
            };
            unsigned.solana_verification =
                Some(crate::bitcoin::frost_client::SolanaVerification::Withdrawal {
                    requester: request.user_solana_address.clone(),
                    nonce,
                    expected_amount_sats: request.amount_sats,  // gross (PDA)
                    expected_send_amount: Some(unsigned.send_amount),  // net (tx output)
                    expected_btc_address: btc_script_hex,
                });
        }

        // Sign
        let signed_tx = self
            .signer
            .sign(&unsigned)
            .await
            .map_err(|e| ServiceError::SignError(e.to_string()))?;

        let tx_hex = bitcoin::consensus::encode::serialize_hex(&signed_tx);
        let txid = signed_tx.compute_txid().to_string();

        // Broadcast
        let broadcast_mode =
            std::env::var("AEGIS_BROADCAST_MODE").unwrap_or_else(|_| "simulated".to_string());

        if broadcast_mode == "real" {
            println!("=== Broadcasting Transaction (Real) ===");
            println!("TXID: {}", txid);
            println!("Size: {} bytes", tx_hex.len() / 2);
            println!("Miner fee: {} sats | Service fee: {} sats | Send: {} sats",
                unsigned.fee, unsigned.service_fee, unsigned.send_amount);
            self.esplora
                .broadcast_tx(&tx_hex)
                .await
                .map_err(|e| ServiceError::BroadcastError(e.to_string()))?;
        } else {
            println!("=== Broadcasting Transaction (Simulated) ===");
            println!("TXID: {}", txid);
            println!("Size: {} bytes", tx_hex.len() / 2);
            println!("Miner fee: {} sats | Service fee: {} sats | Send: {} sats",
                unsigned.fee, unsigned.service_fee, unsigned.send_amount);
        }

        // Store tracking entry
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let is_simulated = broadcast_mode != "real";
        let entry = RedemptionTracking {
            pda_address: pda.pda_address.clone(),
            btc_txid: Some(txid.clone()),
            local_status: LocalRedemptionStatus::AwaitingConfirmation,
            retry_count: 0,
            created_at: now,
            last_updated: now,
            error: None,
            verified_tx_pda: None,
            buffer_pubkey: None,
            tx_size: None,
            requester: Some(pda.requester.clone()),
            amount_sats: Some(pda.amount_sats),
            btc_script: Some(hex::encode(&pda.btc_script)),
            request_id: Some(pda.request_id),
            simulated: is_simulated,
        };
        self.tracking.upsert(entry).await;

        // Update stats
        let mut stats = self.stats.write().await;
        stats.total_requests += 1;
        stats.processing += 1;
        stats.total_sats_withdrawn += request.amount_sats;
        stats.total_fees_paid += unsigned.fee;

        Ok(ProcessResult {
            request_id: pda.pda_address.clone(),
            btc_txid: txid,
            tx_hex,
            fee: unsigned.fee,
        })
    }

    /// Phase 3: Try to complete a Processing PDA.
    ///
    /// Full SPV pipeline:
    ///   1. Wait for BTC confirmations
    ///   2. Upload raw tx to ChadBuffer + call verify_transaction (creates VerifiedTransaction PDA)
    ///   3. Call complete_redemption (burns zkBTC, closes RedemptionRequest PDA)
    ///   4. Close ChadBuffer
    ///
    /// In simulated mode (AEGIS_BROADCAST_MODE != "real"), skips SPV and just marks locally complete.
    ///
    /// Returns Ok(true) if completed, Ok(false) if not ready yet.
    async fn try_complete_redemption(
        &self,
        pda: &ParsedRedemption,
    ) -> Result<bool, ServiceError> {
        let tracking = match self.tracking.get(&pda.pda_address).await {
            Some(t) => t,
            None => return Ok(false), // not tracked by us
        };

        // Already completed locally?
        if tracking.local_status == LocalRedemptionStatus::Completed {
            return Ok(false);
        }

        let btc_txid = match &tracking.btc_txid {
            Some(txid) => txid.clone(),
            None => return Ok(false), // no txid yet
        };

        let broadcast_mode =
            std::env::var("AEGIS_BROADCAST_MODE").unwrap_or_else(|_| "simulated".to_string());

        // Simulated mode: no real BTC tx to verify — leave as AwaitingConfirmation
        // so the explorer correctly shows that BTC broadcast + SPV + completion are pending.
        if broadcast_mode != "real" {
            return Ok(false);
        }

        // If already SpvVerified, verify the PDA still exists before skipping ahead
        if tracking.local_status == LocalRedemptionStatus::SpvVerified {
            let vt_still_valid = if let Some(ref vt_str) = tracking.verified_tx_pda {
                if let Ok(vt_pk) = vt_str.parse::<solana_sdk::pubkey::Pubkey>() {
                    self.sol_client.account_exists(&vt_pk).unwrap_or(false)
                } else {
                    false
                }
            } else {
                false
            };

            if vt_still_valid {
                return self.call_complete_and_cleanup(pda, tracking).await;
            } else {
                // Stale SpvVerified state — reset to re-run verification
                println!(
                    "[redemption] PDA {} SpvVerified state is stale, resetting to re-verify",
                    &pda.pda_address[..8]
                );
                let now = now_secs();
                let mut entry = tracking.clone();
                entry.local_status = LocalRedemptionStatus::AwaitingConfirmation;
                entry.verified_tx_pda = None;
                entry.buffer_pubkey = None;
                entry.tx_size = None;
                entry.last_updated = now;
                self.tracking.upsert(entry).await;
                // Fall through to re-run the full flow below
            }
        }

        // Check BTC confirmations
        let confirmations = match self.esplora.get_confirmations(&btc_txid).await {
            Ok(c) => c,
            Err(e) => {
                eprintln!(
                    "[redemption] Error checking confirmations for {}: {}",
                    btc_txid, e
                );
                return Ok(false);
            }
        };

        if confirmations < self.config.required_confirmations {
            return Ok(false);
        }

        println!(
            "[redemption] PDA {} BTC confirmed ({} confs >= {}), starting SPV verification",
            &pda.pda_address[..8],
            confirmations,
            self.config.required_confirmations
        );

        // Get payer keypair
        let payer = self.sol_client.payer_keypair().ok_or_else(|| {
            ServiceError::BuildError("no payer keypair set on SolClient".to_string())
        })?;
        let rpc = self.sol_client.rpc();
        let btc_lc_pid = crate::solana::client::BTC_LIGHT_CLIENT_PROGRAM_ID;

        // 1. Fetch raw BTC withdrawal tx, strip witness
        let tx_hex = self
            .esplora
            .get_tx_hex(&btc_txid)
            .await
            .map_err(|e| ServiceError::BuildError(format!("get_tx_hex: {}", e)))?;
        let raw_tx = hex::decode(tx_hex.trim())
            .map_err(|e| ServiceError::BuildError(format!("hex decode raw tx: {}", e)))?;
        let stripped = crate::solana::spv::strip_witness_data(&raw_tx)
            .map_err(|e| ServiceError::BuildError(format!("strip_witness: {}", e)))?;

        // 2. Get block hash from tx status
        let tx_status = self
            .esplora
            .get_tx_status(&btc_txid)
            .await
            .map_err(|e| ServiceError::BuildError(format!("get_tx_status: {}", e)))?;
        let block_hash_hex = tx_status
            .block_hash
            .as_ref()
            .ok_or_else(|| ServiceError::BuildError("tx has no block_hash".to_string()))?;

        let block_hash = crate::solana::spv::txid_to_internal(block_hash_hex)
            .map_err(|e| ServiceError::BuildError(format!("block_hash parse: {}", e)))?;
        let txid_internal = crate::solana::spv::txid_to_internal(&btc_txid)
            .map_err(|e| ServiceError::BuildError(format!("txid parse: {}", e)))?;

        // 3. Derive PDAs
        let verified_tx_pda =
            crate::solana::spv::derive_verified_tx_pda(&block_hash, &txid_internal, &btc_lc_pid);
        let block_header_pda =
            crate::solana::spv::derive_block_header_pda(&block_hash, &btc_lc_pid);
        let light_client_pda = crate::solana::spv::derive_light_client_pda(&btc_lc_pid);

        // 4. Check if block header is relayed — trigger on-demand sync if not
        match self.sol_client.account_exists(&block_header_pda) {
            Ok(true) => {}
            Ok(false) => {
                // Trigger on-demand header sync
                if let Some(relayer) = &self.header_relayer {
                    println!(
                        "[redemption] Block header not relayed for {}, triggering on-demand sync",
                        &btc_txid[..8]
                    );
                    match relayer.sync_headers().await {
                        Ok(n) if n > 0 => {
                            println!("[redemption] On-demand relay: synced {} headers", n);
                        }
                        Ok(_) => {}
                        Err(e) => {
                            eprintln!("[redemption] On-demand relay error: {}", e);
                        }
                    }
                    // Re-check after sync
                    match self.sol_client.account_exists(&block_header_pda) {
                        Ok(true) => {} // proceed
                        _ => {
                            println!(
                                "[redemption] Block header still not available for {}, will retry",
                                &btc_txid[..8]
                            );
                            return Ok(false);
                        }
                    }
                } else {
                    println!(
                        "[redemption] Block header not yet relayed for {}, no relayer available",
                        &btc_txid[..8]
                    );
                    return Ok(false);
                }
            }
            Err(e) => {
                eprintln!("[redemption] Error checking block header PDA: {}", e);
                return Ok(false);
            }
        }

        // 5. Check if already verified (idempotent)
        let already_verified = match self.sol_client.account_exists(&verified_tx_pda) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[redemption] Error checking verified_tx PDA: {}", e);
                return Ok(false);
            }
        };

        let buffer_pubkey;
        let tx_size = stripped.len() as u32;

        if !already_verified {
            // Upload to ChadBuffer + call verify_transaction
            let (buf_pk, _buf_kp) = crate::solana::spv::upload_to_chadbuffer(rpc, payer, &stripped)
                .map_err(|e| ServiceError::BuildError(format!("upload_to_chadbuffer: {}", e)))?;
            buffer_pubkey = buf_pk;

            // Get merkle proof
            let merkle_proof = self
                .esplora
                .get_merkle_proof(&btc_txid)
                .await
                .map_err(|e| ServiceError::BuildError(format!("get_merkle_proof: {}", e)))?;

            let verify_ix = crate::solana::spv::build_verify_transaction_ix(
                &payer.pubkey(),
                &txid_internal,
                &merkle_proof,
                &block_hash,
                tx_size,
                &btc_lc_pid,
                &light_client_pda,
                &block_header_pda,
                &verified_tx_pda,
                &buffer_pubkey,
            )
            .map_err(|e| ServiceError::BuildError(format!("build_verify_tx_ix: {}", e)))?;

            // Send verify_transaction
            let blockhash = rpc
                .get_latest_blockhash()
                .map_err(|e| ServiceError::BuildError(format!("get blockhash: {}", e)))?;
            let tx = solana_sdk::transaction::Transaction::new_signed_with_payer(
                &[verify_ix],
                Some(&payer.pubkey()),
                &[payer],
                blockhash,
            );
            rpc.send_and_confirm_transaction(&tx)
                .map_err(|e| ServiceError::BuildError(format!("verify_transaction failed: {}", e)))?;

            println!(
                "[redemption] verify_transaction succeeded for PDA {}",
                &pda.pda_address[..8]
            );
        } else {
            // Already verified — retrieve buffer_pubkey from tracking if available
            buffer_pubkey = if let Some(ref bp) = tracking.buffer_pubkey {
                bp.parse::<solana_sdk::pubkey::Pubkey>()
                    .map_err(|e| ServiceError::BuildError(format!("parse buffer_pubkey: {}", e)))?
            } else {
                // Need a new buffer for complete_redemption (it reads from it)
                let (buf_pk, _) = crate::solana::spv::upload_to_chadbuffer(rpc, payer, &stripped)
                    .map_err(|e| ServiceError::BuildError(format!("upload_to_chadbuffer: {}", e)))?;
                buf_pk
            };
        }

        // Save progress — SpvVerified state for retry resilience
        let now = now_secs();
        let mut entry = tracking.clone();
        entry.local_status = LocalRedemptionStatus::SpvVerified;
        entry.verified_tx_pda = Some(verified_tx_pda.to_string());
        entry.buffer_pubkey = Some(buffer_pubkey.to_string());
        entry.tx_size = Some(tx_size);
        entry.last_updated = now;
        self.tracking.upsert(entry.clone()).await;

        // 6. Call complete_redemption
        self.call_complete_and_cleanup(pda, entry).await
    }

    /// Call complete_redemption on-chain, close the ChadBuffer, and update tracking to Completed.
    async fn call_complete_and_cleanup(
        &self,
        pda: &ParsedRedemption,
        tracking: RedemptionTracking,
    ) -> Result<bool, ServiceError> {
        let pda_pubkey = pda
            .pda_address
            .parse::<solana_sdk::pubkey::Pubkey>()
            .map_err(|e| ServiceError::BuildError(format!("invalid PDA pubkey: {}", e)))?;

        let btc_txid = tracking.btc_txid.as_ref().ok_or_else(|| {
            ServiceError::BuildError("no btc_txid in tracking".to_string())
        })?;
        let txid_internal = crate::solana::spv::txid_to_internal(btc_txid)
            .map_err(|e| ServiceError::BuildError(format!("txid parse: {}", e)))?;

        let verified_tx_str = tracking.verified_tx_pda.as_ref().ok_or_else(|| {
            ServiceError::BuildError("no verified_tx_pda in tracking".to_string())
        })?;
        let verified_tx_pda = verified_tx_str
            .parse::<solana_sdk::pubkey::Pubkey>()
            .map_err(|e| ServiceError::BuildError(format!("parse verified_tx_pda: {}", e)))?;

        let buffer_str = tracking.buffer_pubkey.as_ref().ok_or_else(|| {
            ServiceError::BuildError("no buffer_pubkey in tracking".to_string())
        })?;
        let buffer_pubkey = buffer_str
            .parse::<solana_sdk::pubkey::Pubkey>()
            .map_err(|e| ServiceError::BuildError(format!("parse buffer_pubkey: {}", e)))?;

        let tx_size = tracking.tx_size.ok_or_else(|| {
            ServiceError::BuildError("no tx_size in tracking".to_string())
        })?;

        // Call complete_redemption on-chain
        self.sol_client
            .send_complete_redemption(
                &pda_pubkey,
                &txid_internal,
                &verified_tx_pda,
                &buffer_pubkey,
                tx_size,
            )
            .await
            .map_err(|e| ServiceError::BuildError(format!("complete_redemption: {}", e)))?;

        println!(
            "[redemption] complete_redemption succeeded for PDA {}",
            &pda.pda_address[..8]
        );

        // Close ChadBuffer to reclaim rent
        let payer = self.sol_client.payer_keypair().ok_or_else(|| {
            ServiceError::BuildError("no payer keypair".to_string())
        })?;
        if let Err(e) = crate::solana::spv::close_chadbuffer(self.sol_client.rpc(), payer, &buffer_pubkey) {
            eprintln!("[redemption] Warning: failed to close ChadBuffer: {}", e);
        }

        // Update tracking to Completed
        let now = now_secs();
        let mut entry = tracking;
        entry.local_status = LocalRedemptionStatus::Completed;
        entry.buffer_pubkey = None;
        entry.last_updated = now;
        self.tracking.upsert(entry).await;

        // Update stats
        let mut stats = self.stats.write().await;
        stats.processing = stats.processing.saturating_sub(1);
        stats.complete += 1;

        Ok(true)
    }

    /// Run the service loop
    pub async fn run(&self) -> Result<(), ServiceError> {
        {
            let mut running = self.running.write().await;
            *running = true;
        }

        println!("=== Redemption Service Started ===");
        println!("Check interval: {} seconds", self.config.check_interval_secs);
        println!("Signer type: {}", self.signer.signer_type());
        println!("Pool public key: {}", self.signer.public_key());
        println!();

        // Spawn WebSocket listener for real-time PDA change notifications
        let ws_notify = self.ws_notify.clone();
        let ws_url = self
            .config
            .solana_rpc
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let program_id = self.sol_client.program_id_str();

        tokio::spawn(async move {
            let listener = RedemptionWsListener::new(ws_url, program_id, ws_notify);
            listener.run().await;
        });

        loop {
            {
                let running = self.running.read().await;
                if !*running {
                    break;
                }
            }

            match self.tick().await {
                Ok(result) => {
                    if result.has_activity() {
                        println!("[tick] {}", result);
                    }
                }
                Err(e) => {
                    eprintln!("[tick] Error: {}", e);
                }
            }

            // Wait for either the poll interval or a WS notification
            let poll_duration = tokio::time::Duration::from_secs(self.config.check_interval_secs);
            tokio::select! {
                _ = tokio::time::sleep(poll_duration) => {}
                _ = self.ws_notify.notified() => {
                    println!("[redemption] WS notification received, scanning immediately");
                }
            }
        }

        println!("=== Redemption Service Stopped ===");
        Ok(())
    }

    /// Stop the service
    pub async fn stop(&self) {
        let mut running = self.running.write().await;
        *running = false;
    }

    /// Get current statistics
    pub async fn stats(&self) -> RedemptionStats {
        self.stats.read().await.clone()
    }

    /// Get current service fee config (bps, base) from the builder (refreshed from chain each tick)
    pub async fn service_fee_config(&self) -> (u16, u64) {
        let b = self.builder.read().await;
        (b.service_fee_bps(), b.service_fee_base())
    }

    /// Get min/max withdrawal limits (loaded from on-chain PoolState at startup)
    pub fn withdrawal_limits(&self) -> (u64, u64) {
        (self.config.min_withdrawal, self.config.max_withdrawal)
    }

    /// Get all withdrawal requests
    pub async fn get_all_requests(&self) -> Vec<WithdrawalRequest> {
        self.queue.get_all().await
    }

    /// Get request by ID
    pub async fn get_request(&self, id: &str) -> Option<WithdrawalRequest> {
        self.queue.get(id).await
    }

    /// Get pool public key
    pub fn pool_public_key(&self) -> String {
        self.signer.public_key().to_string()
    }

    /// Get signer type
    pub fn signer_type(&self) -> &'static str {
        self.signer.signer_type()
    }
}

/// Result of processing a withdrawal
#[derive(Debug, Clone)]
pub struct ProcessResult {
    pub request_id: String,
    pub btc_txid: String,
    pub tx_hex: String,
    pub fee: u64,
}

/// Result of a service tick
#[derive(Debug, Default)]
pub struct TickResult {
    pub pending_pdas: usize,
    pub withdrawals_processed: usize,
    pub withdrawals_completed: usize,
}

impl TickResult {
    pub fn has_activity(&self) -> bool {
        self.pending_pdas > 0
            || self.withdrawals_processed > 0
            || self.withdrawals_completed > 0
    }
}

impl std::fmt::Display for TickResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "pending_pdas: {}, processed: {}, completed: {}",
            self.pending_pdas,
            self.withdrawals_processed,
            self.withdrawals_completed
        )
    }
}

/// Service errors
#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("amount too small: min {min}, got {got}")]
    AmountTooSmall { min: u64, got: u64 },

    #[error("amount too large: max {max}, got {got}")]
    AmountTooLarge { max: u64, got: u64 },

    #[error("invalid address: {0}")]
    InvalidAddress(String),

    #[error("queue error: {0}")]
    QueueError(String),

    #[error("request not found: {0}")]
    NotFound(String),

    #[error("no UTXOs available")]
    NoUtxos,

    #[error("build error: {0}")]
    BuildError(String),

    #[error("sign error: {0}")]
    SignError(String),

    #[error("broadcast error: {0}")]
    BroadcastError(String),

    #[error("watcher error: {0}")]
    WatcherError(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_submit_withdrawal() {
        let service = RedemptionService::new_testnet();

        let result = service
            .submit_withdrawal(
                "sol_tx_123".to_string(),
                "user_pubkey".to_string(),
                100_000,
                "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx".to_string(),
                None,
            )
            .await;

        assert!(result.is_ok());

        let id = result.unwrap();
        let request = service.get_request(&id).await.unwrap();

        assert_eq!(request.amount_sats, 100_000);
        assert_eq!(request.status, WithdrawalStatus::Pending);
    }

    #[tokio::test]
    async fn test_amount_validation() {
        let service = RedemptionService::new_testnet();

        // Too small
        let result = service
            .submit_withdrawal(
                "tx".to_string(),
                "user".to_string(),
                100, // Too small
                "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx".to_string(),
                None,
            )
            .await;

        assert!(matches!(result, Err(ServiceError::AmountTooSmall { .. })));
    }

    #[test]
    fn test_tick_result_display() {
        let result = TickResult {
            pending_pdas: 3,
            withdrawals_processed: 1,
            withdrawals_completed: 0,
        };
        let s = format!("{}", result);
        assert!(s.contains("pending_pdas: 3"));
    }
}
