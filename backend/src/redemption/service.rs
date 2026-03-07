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

use crate::bitcoin::client::EsploraClient;
use crate::redemption::builder::TxBuilder;
use crate::redemption::queue::WithdrawalQueue;
use crate::redemption::signer::{SingleKeySigner, TxSigner};
use crate::redemption::tracking::TrackingStore;
use crate::redemption::types::*;
use crate::redemption::watcher::RedemptionScanner;
use crate::redemption::ws_redemption::RedemptionWsListener;
use crate::solana::client::SolClient;

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

    /// Transaction builder
    builder: TxBuilder,

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
}

impl RedemptionService {
    /// Create a new redemption service with any TxSigner implementation
    pub fn new_with_signer(
        config: RedemptionConfig,
        signer: impl TxSigner + 'static,
        sol_client: SolClient,
    ) -> Self {
        let scanner = RedemptionScanner::new(SolClient::new_like(&sol_client));
        let sol_client = Arc::new(sol_client);
        let tracking = TrackingStore::new("redemption_tracking.json");
        let ws_notify = Arc::new(Notify::new());

        let mut builder = TxBuilder::new_testnet();
        builder.set_service_fee(config.service_fee_sats);

        Self {
            scanner,
            tracking,
            sol_client,
            ws_notify,
            queue: WithdrawalQueue::default(),
            builder,
            signer: Arc::new(signer),
            esplora: EsploraClient::from_network(crate::config::Network::Devnet),
            pool_utxos: Arc::new(RwLock::new(Vec::new())),
            stats: Arc::new(RwLock::new(RedemptionStats::default())),
            running: Arc::new(RwLock::new(false)),
            config,
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
        self.builder
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

        // Phase 0: Refresh pool UTXOs from Esplora
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
                // Processing on-chain but not tracked locally — try to build BTC tx
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
            };
            self.tracking.upsert(entry).await;
            return Err(ServiceError::NoUtxos);
        }

        let mut unsigned = self
            .builder
            .build_withdrawal(&request, &utxos)
            .map_err(|e| ServiceError::BuildError(e.to_string()))?;

        // Attach Solana verification data for FROST signers
        if let Some(nonce) = request.redemption_nonce {
            unsigned.solana_verification =
                Some(crate::bitcoin::frost_client::SolanaVerification::Withdrawal {
                    requester: request.user_solana_address.clone(),
                    nonce,
                    expected_amount_sats: request.amount_sats,
                    expected_btc_address: request.btc_address.clone(),
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
        let entry = RedemptionTracking {
            pda_address: pda.pda_address.clone(),
            btc_txid: Some(txid.clone()),
            local_status: LocalRedemptionStatus::AwaitingConfirmation,
            retry_count: 0,
            created_at: now,
            last_updated: now,
            error: None,
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

        // Check BTC confirmations (need >= 6)
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

        if confirmations < 6 {
            return Ok(false);
        }

        // Check if VerifiedTransaction PDA exists
        // We need block_hash from esplora to derive the PDA
        let tx_status = match self.esplora.get_tx_status(&btc_txid).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "[redemption] Error getting tx status for {}: {}",
                    btc_txid, e
                );
                return Ok(false);
            }
        };

        let block_hash_hex = match &tx_status.block_hash {
            Some(h) => h.clone(),
            None => return Ok(false),
        };

        // Decode block_hash and txid to bytes for PDA derivation
        let block_hash_bytes: [u8; 32] = hex::decode(&block_hash_hex)
            .ok()
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .unwrap_or_default();

        let txid_bytes: [u8; 32] = hex::decode(&btc_txid)
            .ok()
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .unwrap_or_default();

        let verified_tx_pda = SolClient::derive_verified_tx_pda(&block_hash_bytes, &txid_bytes);

        match self.sol_client.account_exists(&verified_tx_pda) {
            Ok(true) => {
                // VerifiedTransaction PDA exists — ready to complete
                println!(
                    "[redemption] PDA {} confirmed ({} confs), marking complete",
                    &pda.pda_address[..8],
                    confirmations
                );

                // TODO: Actually call send_complete_redemption once ChadBuffer is available.
                // For now, just update local tracking.
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                let mut entry = tracking;
                entry.local_status = LocalRedemptionStatus::Completed;
                entry.last_updated = now;
                self.tracking.upsert(entry).await;

                // Update stats
                let mut stats = self.stats.write().await;
                stats.processing = stats.processing.saturating_sub(1);
                stats.complete += 1;

                Ok(true)
            }
            Ok(false) => {
                // Not yet verified on Solana
                Ok(false)
            }
            Err(e) => {
                eprintln!(
                    "[redemption] Error checking verified_tx PDA: {}",
                    e
                );
                Ok(false)
            }
        }
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
