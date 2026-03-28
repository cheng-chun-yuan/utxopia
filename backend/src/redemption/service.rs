//! Redemption Service
//!
//! Main service that scans on-chain RedemptionRequest PDAs and triggers BTC withdrawals.
//! Uses a 3-phase tick loop:
//!   Phase 1: Scan PDAs — find new RedemptionRequest accounts
//!   Phase 2: Process new (Pending) PDAs — build BTC tx, FROST sign, broadcast
//!   Phase 3: Try to complete (Processing) PDAs — wait for BTC confirmations,
//!            submit SPV proof, call complete_redemption on-chain
//!
//! Also handles recovery of untracked redemptions (PDAs that exist on-chain
//! but aren't in local tracking store — e.g. after service restart).
//!
//! Signing modes:
//! - SingleKey: POC mode using a local secp256k1 key
//! - FROST: production mode using 2-of-3 threshold signing via FROST servers

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

/// Parse a raw (non-witness) BTC transaction and find the vout index of the output
/// matching the given scriptPubKey (pool change output).
fn find_change_vout(raw_tx: &[u8], pool_script: &[u8]) -> Option<u32> {
    let mut offset = 4; // skip version
    if offset >= raw_tx.len() { return None; }

    // Skip inputs
    let (input_count, vs) = read_varint_service(&raw_tx[offset..])?;
    offset += vs;
    for _ in 0..input_count {
        offset += 36; // prev_txid + prev_vout
        if offset >= raw_tx.len() { return None; }
        let (script_len, vs) = read_varint_service(&raw_tx[offset..])?;
        offset += vs + script_len as usize + 4; // script + sequence
    }

    // Read output count
    if offset >= raw_tx.len() { return None; }
    let (output_count, vs) = read_varint_service(&raw_tx[offset..])?;
    offset += vs;

    for i in 0..output_count {
        if offset + 8 > raw_tx.len() { return None; }
        offset += 8; // skip value

        let (script_len, vs) = read_varint_service(&raw_tx[offset..])?;
        offset += vs;
        let script_end = offset + script_len as usize;
        if script_end > raw_tx.len() { return None; }

        if &raw_tx[offset..script_end] == pool_script {
            return Some(i as u32);
        }
        offset = script_end;
    }
    None
}

fn read_varint_service(data: &[u8]) -> Option<(u64, usize)> {
    if data.is_empty() { return None; }
    match data[0] {
        0..=0xfc => Some((data[0] as u64, 1)),
        0xfd if data.len() >= 3 => Some((u16::from_le_bytes([data[1], data[2]]) as u64, 3)),
        0xfe if data.len() >= 5 => Some((u32::from_le_bytes([data[1], data[2], data[3], data[4]]) as u64, 5)),
        0xff if data.len() >= 9 => Some((u64::from_le_bytes([data[1], data[2], data[3], data[4], data[5], data[6], data[7], data[8]]), 9)),
        _ => None,
    }
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
        let tracking = TrackingStore::new("data/redemption_tracking.db");
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

        // Phase 0: Refresh on-chain config + UTXOs
        self.refresh_state().await;

        // Phase 1: Scan PDAs + reconcile tracking
        let scan = self
            .scanner
            .scan()
            .map_err(|e| ServiceError::WatcherError(e.to_string()))?;
        result.pending_pdas = scan.pending.len();
        self.tracking.reconcile(&scan.all_addresses()).await;

        // Phase 2: Process pending redemptions
        result.withdrawals_processed += self.process_pending_pdas(&scan.pending).await;

        // Phase 3: Complete processing redemptions
        let (processed, completed) = self.complete_processing_pdas(&scan.processing).await;
        result.withdrawals_processed += processed;
        result.withdrawals_completed += completed;

        Ok(result)
    }

    /// Phase 0: Refresh pool config and UTXOs.
    async fn refresh_state(&self) {
        match self.sol_client.fetch_pool_config() {
            Ok(pool_cfg) => {
                self.builder.write().await.set_service_fee_model(
                    pool_cfg.service_fee_bps,
                    pool_cfg.service_fee_base,
                );
            }
            Err(e) => eprintln!("[tick] Warning: failed to refresh pool config: {:?}", e),
        }
        if let Err(e) = self.refresh_pool_utxos().await {
            eprintln!("[tick] Warning: failed to refresh UTXOs: {}", e);
        }
    }

    /// Phase 2: Process new Pending PDAs (or retry previously failed ones).
    async fn process_pending_pdas(&self, pending: &[ParsedRedemption]) -> usize {
        let mut count = 0;
        for pda in pending {
            if let Some(entry) = self.tracking.get(&pda.pda_address).await {
                if entry.local_status != LocalRedemptionStatus::Failed {
                    continue;
                }
                self.tracking.remove(&pda.pda_address).await;
            }
            match self.process_new_redemption(pda).await {
                Ok(_) => count += 1,
                Err(e) => eprintln!("[tick] Error processing PDA {}: {}", &pda.pda_address[..8], e),
            }
        }
        count
    }

    /// Phase 3: Complete Processing PDAs — await BTC confirmations, submit SPV proofs.
    async fn complete_processing_pdas(&self, processing: &[ParsedRedemption]) -> (usize, usize) {
        let mut processed = 0;
        let mut completed = 0;

        for pda in processing {
            if let Some(entry) = self.tracking.get(&pda.pda_address).await {
                // Retry failed builds (no btc_txid yet)
                if entry.local_status == LocalRedemptionStatus::Failed && entry.btc_txid.is_none() {
                    self.tracking.remove(&pda.pda_address).await;
                    match self.build_sign_broadcast(pda).await {
                        Ok(_) => processed += 1,
                        Err(e) => eprintln!("[tick] Retry failed for PDA {}: {}", &pda.pda_address[..8], e),
                    }
                    continue;
                }
            } else {
                // Untracked Processing PDA — try to recover existing BTC tx
                match self.try_recover_untracked_pda(pda).await {
                    Ok(true) => continue,  // Recovered — will complete next tick
                    Ok(false) => {
                        // No recoverable tx — sign fresh
                        match self.build_sign_broadcast(pda).await {
                            Ok(_) => processed += 1,
                            Err(e) => eprintln!("[tick] Error building tx for untracked PDA {}: {}", &pda.pda_address[..8], e),
                        }
                    }
                    Err(e) => eprintln!("[tick] Recovery failed for PDA {}: {}", &pda.pda_address[..8], e),
                }
                continue;
            }

            match self.try_complete_redemption(pda).await {
                Ok(true) => completed += 1,
                Ok(false) => {}
                Err(e) => eprintln!("[tick] Error completing PDA {}: {}", &pda.pda_address[..8], e),
            }
        }

        (processed, completed)
    }

    /// Try to recover an existing BTC tx for an untracked Processing PDA.
    /// Returns Ok(true) if recovered, Ok(false) if no valid tx found.
    async fn try_recover_untracked_pda(&self, pda: &ParsedRedemption) -> Result<bool, ServiceError> {
        let btc_address = script_to_address(&pda.btc_script, bitcoin::Network::Testnet)
            .map_err(|e| ServiceError::BuildError(format!("cannot parse btc_script: {}", e)))?;

        let expected_send = pda.amount_sats.saturating_sub(pda.service_fee);

        let txids = match self.esplora.get_address_txids_with_status(&btc_address).await {
            Ok(t) => t,
            Err(_) => return Ok(false),
        };

        for (txid, is_confirmed) in &txids {
            // Skip txids already completed on-chain
            let mut txid_bytes = [0u8; 32];
            if let Ok(decoded) = hex::decode(txid) {
                if decoded.len() == 32 {
                    txid_bytes.copy_from_slice(&decoded);
                    txid_bytes.reverse();
                }
            }
            let receipt_seeds: &[&[u8]] = &[b"completion_receipt", &txid_bytes];
            let (receipt_pda, _) = solana_sdk::pubkey::Pubkey::find_program_address(
                receipt_seeds,
                self.sol_client.program_id(),
            );
            if self.sol_client.rpc().get_account(&receipt_pda).is_ok() {
                continue;
            }

            // Verify output amount matches
            let tx_detail = match self.esplora.get_tx(txid).await {
                Ok(d) => d,
                Err(_) => continue,
            };
            if !tx_detail.vout.iter().any(|o| o.value == expected_send) {
                continue;
            }

            println!(
                "[tick] Recovered BTC tx {} (confirmed={}) for PDA {} (dest: {})",
                &txid[..12], *is_confirmed, &pda.pda_address[..8], &btc_address
            );
            let entry = RedemptionTracking {
                pda_address: pda.pda_address.clone(),
                btc_txid: Some(txid.clone()),
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
                consumed_utxo_pdas: vec![],
                pool_script_hex: None,
            };
            self.tracking.upsert(entry).await;
            return Ok(true);
        }

        println!(
            "[tick] No valid BTC tx for untracked PDA {}, signing fresh (send: {} sats)",
            &pda.pda_address[..8], expected_send
        );
        Ok(false)
    }

    /// Phase 2: Process a newly-discovered Pending PDA.
    ///
    /// 1. Build BTC tx (selects Esplora UTXOs)
    /// 2. Match selected UTXOs to on-chain UTXO PDAs
    /// 3. send_mark_processing with matched UTXO PDAs (reserves them + computes total_input_sats)
    /// 4. Sign and broadcast BTC tx
    async fn process_new_redemption(
        &self,
        pda: &ParsedRedemption,
    ) -> Result<ProcessResult, ServiceError> {
        let pda_pubkey = pda
            .pda_address
            .parse::<solana_sdk::pubkey::Pubkey>()
            .map_err(|e| ServiceError::BuildError(format!("invalid PDA pubkey: {}", e)))?;

        // Step 1: Build the BTC tx to know which UTXOs are selected
        let btc_address = script_to_address(&pda.btc_script, bitcoin::Network::Testnet)
            .map_err(|e| ServiceError::InvalidAddress(e))?;

        let mut request = WithdrawalRequest::new(
            String::new(),
            pda.requester.clone(),
            pda.amount_sats,
            btc_address.clone(),
        );
        request.redemption_nonce = Some(pda.request_id);
        request.pda_service_fee = Some(pda.service_fee);

        let utxos = self.pool_utxos.read().await.clone();
        if utxos.is_empty() {
            return Err(ServiceError::NoUtxos);
        }

        let unsigned = self
            .builder.read().await
            .build_withdrawal(&request, &utxos)
            .map_err(|e| ServiceError::BuildError(e.to_string()))?;

        // Step 2: Match builder-selected UTXOs to on-chain UTXO PDAs
        let utxo_pdas: Vec<solana_sdk::pubkey::Pubkey> = unsigned.utxos.iter()
            .filter_map(|u| {
                let txid_internal = crate::solana::spv::txid_to_internal(&u.txid).ok()?;
                Some(crate::solana::client::SolClient::derive_utxo_pda(
                    self.sol_client.program_id(),
                    &txid_internal,
                    u.vout,
                ))
            })
            .collect();

        // Step 3: Mark processing on-chain with only the selected UTXO PDAs
        self.sol_client
            .send_mark_processing(&pda_pubkey, &utxo_pdas)
            .await
            .map_err(|e| ServiceError::BuildError(format!("send_mark_processing: {}", e)))?;

        println!(
            "[redemption] Marked PDA {} as Processing (amount={}, utxos={})",
            &pda.pda_address[..8],
            pda.amount_sats,
            utxo_pdas.len(),
        );

        // Step 4: Sign and broadcast (reuses pre-built unsigned tx)
        self.sign_broadcast_with_tx(pda, &request, unsigned, &utxo_pdas).await
    }

    /// Build, sign, and broadcast a BTC transaction for a PDA already marked Processing.
    ///
    /// Used for retrying Processing PDAs that failed the BTC tx step.
    /// For new redemptions, use process_new_redemption which builds first then marks.
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
            let now = now_secs();
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
                consumed_utxo_pdas: vec![],
                pool_script_hex: None,
            };
            self.tracking.upsert(entry).await;
            return Err(ServiceError::NoUtxos);
        }

        let unsigned = self
            .builder.read().await
            .build_withdrawal(&request, &utxos)
            .map_err(|e| ServiceError::BuildError(e.to_string()))?;

        // For retries, UTXOs are already reserved — pass empty list
        self.sign_broadcast_with_tx(pda, &request, unsigned, &[]).await
    }

    /// Sign and broadcast a pre-built unsigned tx, storing tracking with UTXO PDAs.
    async fn sign_broadcast_with_tx(
        &self,
        pda: &ParsedRedemption,
        request: &WithdrawalRequest,
        mut unsigned: crate::redemption::builder::UnsignedTx,
        reserved_utxo_pdas: &[solana_sdk::pubkey::Pubkey],
    ) -> Result<ProcessResult, ServiceError> {
        // Attach Solana verification data for FROST signers
        if let Some(nonce) = request.redemption_nonce {
            // FROST policy expects hex scriptPubKey, not bech32 address
            let btc_script_hex = {
                let addr = bitcoin::Address::from_str(&request.btc_address)
                    .map_err(|e| ServiceError::InvalidAddress(format!("parse address: {}", e)))?
                    .assume_checked();
                hex::encode(addr.script_pubkey().as_bytes())
            };
            // Build UTXO inputs list from selected UTXOs for FROST signer verification.
            // Each signer independently verifies these against on-chain Reserved UtxoRecord PDAs.
            let utxo_inputs: Vec<(String, u32, u64)> = unsigned.utxos.iter().map(|u| {
                // Convert txid to internal byte order (reverse of display order) for PDA derivation
                let txid_bytes: Vec<u8> = hex::decode(&u.txid)
                    .unwrap_or_default()
                    .into_iter()
                    .rev()
                    .collect();
                (hex::encode(&txid_bytes), u.vout, u.amount_sats)
            }).collect();

            unsigned.solana_verification =
                Some(crate::bitcoin::frost_client::SolanaVerification::Withdrawal {
                    requester: request.user_solana_address.clone(),
                    nonce,
                    expected_amount_sats: request.amount_sats,  // gross (PDA)
                    expected_send_amount: Some(unsigned.send_amount),  // net (tx output)
                    expected_btc_address: btc_script_hex,
                    utxo_inputs,
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

        // Derive pool scriptPubKey for change detection
        let pool_script_hex = if !self.config.pool_address.is_empty() {
            match bitcoin::Address::from_str(&self.config.pool_address) {
                Ok(addr) => Some(hex::encode(addr.assume_checked().script_pubkey().as_bytes())),
                Err(_) => None,
            }
        } else {
            None
        };

        // Store tracking entry with reserved UTXO PDAs
        let now = now_secs();
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
            consumed_utxo_pdas: reserved_utxo_pdas.iter().map(|p| p.to_string()).collect(),
            pool_script_hex,
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

        // Recover pool scriptPubKey from tracking or config
        let pool_script: Vec<u8> = tracking.pool_script_hex.as_ref()
            .and_then(|h| hex::decode(h).ok())
            .unwrap_or_else(|| {
                if !self.config.pool_address.is_empty() {
                    bitcoin::Address::from_str(&self.config.pool_address).ok()
                        .map(|a| a.assume_checked().script_pubkey().as_bytes().to_vec())
                        .unwrap_or_default()
                } else {
                    vec![]
                }
            });

        // Recover consumed UTXO PDAs from tracking (stored at mark_processing time)
        let consumed_utxo_pdas: Vec<solana_sdk::pubkey::Pubkey> = tracking.consumed_utxo_pdas.iter()
            .filter_map(|s| s.parse::<solana_sdk::pubkey::Pubkey>().ok())
            .collect();

        // Derive change UTXO PDA by parsing the raw BTC tx to find the change output.
        // The change output pays back to the pool's scriptPubKey.
        let change_utxo_pda = if !pool_script.is_empty() {
            // We need the raw BTC tx to find the change vout. Read from ChadBuffer.
            // The buffer is still open at this point (closed after complete_redemption).
            // Parse the raw tx to find the output matching pool_script.
            let rpc = self.sol_client.rpc();
            match rpc.get_account(&buffer_pubkey) {
                Ok(account) => {
                    let buf_data = &account.data;
                    // ChadBuffer: 32-byte header + raw tx
                    if buf_data.len() > 32 + tx_size as usize {
                        let raw_tx = &buf_data[32..32 + tx_size as usize];
                        find_change_vout(raw_tx, &pool_script).map(|change_vout| {
                            let vout_le = change_vout.to_le_bytes();
                            let (pda, _) = solana_sdk::pubkey::Pubkey::find_program_address(
                                &[b"utxo", &txid_internal, &vout_le],
                                self.sol_client.program_id(),
                            );
                            pda
                        })
                    } else {
                        None
                    }
                }
                Err(_) => None,
            }
        } else {
            None
        };

        // Call complete_redemption on-chain
        match self.sol_client
            .send_complete_redemption(
                &pda_pubkey,
                &txid_internal,
                &verified_tx_pda,
                &buffer_pubkey,
                tx_size,
                &pool_script,
                &consumed_utxo_pdas,
                change_utxo_pda.as_ref(),
            )
            .await
        {
            Ok(_) => {
                println!(
                    "[redemption] complete_redemption succeeded for PDA {}",
                    &pda.pda_address[..8]
                );
            }
            Err(e) => {
                // On-chain verification failed (wrong tx, amount mismatch, etc.)
                // Drop tracking so next tick can re-scan or FROST sign fresh
                eprintln!(
                    "[redemption] complete_redemption FAILED for PDA {} (btc_tx {}): {}. Dropping tracking to retry.",
                    &pda.pda_address[..8],
                    btc_txid,
                    e
                );
                self.tracking.remove(&pda.pda_address).await;
                return Err(ServiceError::BuildError(format!("complete_redemption: {}", e)));
            }
        }

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

    #[tokio::test(flavor = "multi_thread")]
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

    #[tokio::test(flavor = "multi_thread")]
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
