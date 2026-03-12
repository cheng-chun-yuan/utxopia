//! Deposit Tracker Service
//!
//! Main service that tracks Bitcoin deposits through their lifecycle:
//! pending → detected → confirming → confirmed → sweeping → sweep_confirming → verifying → ready
//!
//! # Flow:
//! 1. User registers deposit (taproot address + commitment)
//! 2. Service polls Esplora for incoming transactions
//! 3. Once confirmed (configurable blocks), sweeps UTXO to pool wallet
//! 4. After sweep confirms (2 blocks), submits SPV proof to Solana
//! 5. User can claim zkBTC once status is "ready"
//!
//! # Persistence:
//! Uses SQLite for durable storage. Service can restart and resume processing.

use solana_sdk::signature::Keypair;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio::time::{interval, Duration};

use super::header_relayer::HeaderRelayer;
use super::sqlite_db::{SqliteDepositStore, SqliteError};
use super::sweeper::{SweeperError, UtxoSweeper};
use super::types::{DepositRecord, DepositStatus, TrackerConfig, TrackerStats};
use super::verifier::{SpvVerifier, VerifierError};
use super::watcher::{AddressWatcher, WatcherError};
use super::websocket::{DepositUpdatePublisher, SharedWebSocketState};
use super::ws_listener::{MempoolWsListener, WsEvent};

/// Deposit tracker service errors
#[derive(Debug, thiserror::Error)]
pub enum TrackerError {
    #[error("Deposit not found: {0}")]
    NotFound(String),

    #[error("Invalid commitment: {0}")]
    InvalidCommitment(String),

    #[error("Invalid address: {0}")]
    InvalidAddress(String),

    #[error("Watcher error: {0}")]
    Watcher(#[from] WatcherError),

    #[error("Sweeper error: {0}")]
    Sweeper(#[from] SweeperError),

    #[error("Verifier error: {0}")]
    Verifier(#[from] VerifierError),

    #[error("Duplicate deposit: {0}")]
    Duplicate(String),

    #[error("Database error: {0}")]
    Database(#[from] SqliteError),
}

/// Main deposit tracker service
pub struct DepositTrackerService {
    /// Configuration
    config: TrackerConfig,
    /// SQLite persistent storage
    db: SqliteDepositStore,
    /// Address watcher
    watcher: AddressWatcher,
    /// UTXO sweeper
    sweeper: Option<UtxoSweeper>,
    /// SPV verifier
    verifier: Option<SpvVerifier>,
    /// WebSocket publisher
    publisher: Option<DepositUpdatePublisher>,
    /// Last block height scanned for deposits (atomic for interior mutability)
    last_scanned_height: AtomicU64,
    /// Header relayer (shared with WS listener for on-demand sync)
    header_relayer: Option<Arc<HeaderRelayer>>,
}

impl DepositTrackerService {
    /// Create a new tracker service for testnet with SQLite persistence
    pub fn new_testnet(config: TrackerConfig) -> Self {
        let db = SqliteDepositStore::new(&config.db_path)
            .expect("Failed to initialize SQLite database");
        let watcher = AddressWatcher::from_network(crate::config::Network::Devnet);

        Self {
            config,
            db,
            watcher,
            sweeper: None,
            verifier: None,
            publisher: None,
            last_scanned_height: AtomicU64::new(0),
            header_relayer: None,
        }
    }

    /// Create with custom configuration
    pub fn new(config: TrackerConfig) -> Self {
        let db = SqliteDepositStore::new(&config.db_path)
            .expect("Failed to initialize SQLite database");
        let watcher = AddressWatcher::new(&config.esplora_url);

        Self {
            config,
            db,
            watcher,
            sweeper: None,
            verifier: None,
            publisher: None,
            last_scanned_height: AtomicU64::new(0),
            header_relayer: None,
        }
    }

    /// Set up sweeper with pool private key
    pub fn with_sweeper(mut self, pool_signing_key: &str) -> Result<Self, TrackerError> {
        let sweeper = UtxoSweeper::from_private_key(
            pool_signing_key,
            self.config.pool_receive_address.clone(),
            bitcoin::Network::Testnet,
        )
        .map_err(|e| TrackerError::InvalidAddress(e.to_string()))?;

        self.sweeper = Some(sweeper);
        Ok(self)
    }

    /// Set up sweeper with FROST threshold signing
    pub fn with_frost_sweeper(
        mut self,
        frost_client: crate::bitcoin::frost_client::FrostClient,
        group_pubkey: bitcoin::XOnlyPublicKey,
        network: bitcoin::Network,
    ) -> Self {
        let sweeper = UtxoSweeper::from_frost_with_esplora(
            frost_client,
            group_pubkey,
            self.config.pool_receive_address.clone(),
            network,
            Some(&self.config.esplora_url),
        );
        self.sweeper = Some(sweeper);
        self
    }

    /// Set up verifier with Solana keypair
    pub fn with_verifier(mut self, keypair: Keypair) -> Self {
        let program_id = std::env::var("AEGIS_PROGRAM_ID")
            .unwrap_or_else(|_| "4Gt66pJd6N3hYEVWnaWTSLfxotsPvShYEWYvbUB9Ubx1".to_string());
        let mut verifier = if self.config.esplora_url.contains("localhost") || self.config.esplora_url.contains("127.0.0.1") {
            // Custom esplora URL (e.g., regtest) — use it for the verifier too
            match SpvVerifier::new(&self.config.solana_rpc, &self.config.esplora_url, &program_id) {
                Ok(v) => v,
                Err(_) => SpvVerifier::new_testnet(&self.config.solana_rpc),
            }
        } else {
            SpvVerifier::new_testnet(&self.config.solana_rpc)
        };
        verifier.set_payer(keypair);
        self.verifier = Some(verifier);
        self
    }

    /// Set up WebSocket publisher
    pub fn with_websocket(mut self, ws_state: SharedWebSocketState) -> Self {
        self.publisher = Some(DepositUpdatePublisher::new(ws_state));
        self
    }

    /// Register a new deposit for tracking.
    /// If a deposit with the same taproot_address already exists, returns the existing record.
    pub fn register_deposit(
        &self,
        taproot_address: String,
        commitment: String,
        amount_sats: u64,
        ephemeral_pub: Option<String>,
    ) -> Result<DepositRecord, TrackerError> {
        // Check for existing deposit at this address
        if let Some(existing) = self.db.get_by_address(&taproot_address)? {
            return Ok(existing);
        }

        let mut record = DepositRecord::new(taproot_address, commitment.clone(), amount_sats);
        record.ephemeral_pub = ephemeral_pub;
        // commitment field is the npk for npk-based deposits
        record.npk = Some(commitment);

        self.db.insert(&record).map_err(|e| match e {
            SqliteError::Duplicate(msg) => TrackerError::Duplicate(msg),
            other => TrackerError::Database(other),
        })?;
        Ok(record)
    }

    /// Get deposit by ID
    pub fn get_deposit(&self, id: &str) -> Option<DepositRecord> {
        self.db.get_by_id(id).ok().flatten()
    }

    /// Get deposit by address
    pub fn get_deposit_by_address(&self, address: &str) -> Option<DepositRecord> {
        self.db.get_by_address(address).ok().flatten()
    }

    /// Update a deposit record in the database
    pub fn update_deposit(&self, record: &DepositRecord) -> Result<(), TrackerError> {
        self.db.update(record)?;
        Ok(())
    }

    /// Get all deposits
    pub fn get_all_deposits(&self) -> Vec<DepositRecord> {
        self.db.get_all().unwrap_or_default()
    }

    /// Get statistics
    pub fn stats(&self) -> TrackerStats {
        let counts = self.db.count_by_status().unwrap_or_default();
        let total_sats = self.db.total_sats_received().unwrap_or(0);

        TrackerStats {
            total_deposits: counts.values().sum(),
            pending: *counts.get("pending").unwrap_or(&0),
            confirming: counts.get("confirming").unwrap_or(&0)
                + counts.get("detected").unwrap_or(&0),
            ready: *counts.get("ready").unwrap_or(&0),
            claimed: *counts.get("claimed").unwrap_or(&0),
            failed: *counts.get("failed").unwrap_or(&0),
            total_sats_received: total_sats,
        }
    }

    /// Check if a deposit UTXO was spent to the pool address (external sweep).
    /// Returns `Some((spending_txid, fee))` if the UTXO was swept to the pool.
    async fn check_external_sweep(&self, deposit_txid: &str, deposit_vout: u32) -> Option<(String, u64)> {
        let spending_txid = match self.watcher.get_outspend(deposit_txid, deposit_vout).await {
            Ok(Some(txid)) => txid,
            _ => return None,
        };

        let tx = match self.watcher.get_tx(&spending_txid).await {
            Ok(tx) => tx,
            Err(_) => return None,
        };

        let pool_addr = &self.config.pool_receive_address;
        let sends_to_pool = tx.vout.iter().any(|o| {
            o.scriptpubkey_address.as_deref() == Some(pool_addr)
        });

        if sends_to_pool {
            Some((spending_txid, tx.fee))
        } else {
            None
        }
    }

    /// Recover in-progress deposits after service restart.
    ///
    /// For each active deposit:
    /// 1. Reset mid-operation states (sweeping/verifying)
    /// 2. Check on-chain if the deposit UTXO was already spent (external sweep)
    /// 3. If swept to pool address, record the sweep txid and advance to SweepConfirming
    pub async fn recover_in_progress_deposits(&self) -> Result<u32, TrackerError> {
        let active = self.db.get_active()?;
        let mut recovered = 0;

        for mut record in active {
            let old_status = record.status;

            // Step 1: Reset mid-operation states
            match record.status {
                DepositStatus::Sweeping => {
                    if record.sweep_txid.is_none() {
                        record.status = DepositStatus::Confirmed;
                    } else {
                        record.status = DepositStatus::SweepConfirming;
                    }
                    record.error = None;
                    self.db.update(&record)?;
                    println!(
                        "[{}] Recovered interrupted deposit, reset to {:?}",
                        record.id, record.status
                    );
                    recovered += 1;
                }
                DepositStatus::Verifying => {
                    record.status = DepositStatus::SweepConfirming;
                    record.error = None;
                    self.db.update(&record)?;
                    println!(
                        "[{}] Recovered interrupted deposit, reset to {:?}",
                        record.id, record.status
                    );
                    recovered += 1;
                }
                _ => {}
            }

            // Step 2: For deposits with a known txid but no sweep, check on-chain
            if record.sweep_txid.is_none() {
                if let (Some(ref dep_txid), Some(dep_vout)) = (&record.deposit_txid, record.deposit_vout) {
                    if let Some((sweep_txid, fee)) = self.check_external_sweep(dep_txid, dep_vout).await {
                        println!(
                            "[{}] Startup: external sweep detected {} (fee: {} sats), {:?} → SweepConfirming",
                            record.id, sweep_txid, fee, old_status
                        );
                        record.mark_sweep_broadcast(sweep_txid, self.config.pool_receive_address.clone(), fee);
                        self.db.update(&record)?;
                        recovered += 1;
                    }
                }
            }
        }

        // Also recover failed deposits whose UTXO may have been swept while offline
        let failed = self.db.get_by_status(DepositStatus::Failed).unwrap_or_default();
        for mut record in failed {
            if record.sweep_txid.is_some() {
                continue; // Already has sweep tx, retry will handle
            }
            if let (Some(ref dep_txid), Some(dep_vout)) = (&record.deposit_txid, record.deposit_vout) {
                if let Some((sweep_txid, fee)) = self.check_external_sweep(dep_txid, dep_vout).await {
                    println!(
                        "[{}] Startup: failed deposit has external sweep {}, recovering",
                        record.id, sweep_txid
                    );
                    record.mark_sweep_broadcast(sweep_txid, self.config.pool_receive_address.clone(), fee);
                    record.error = None;
                    self.db.update(&record)?;
                    recovered += 1;
                }
            }
        }

        if recovered > 0 {
            println!("Recovered {} deposits via on-chain checks", recovered);
        }

        Ok(recovered)
    }

    /// Startup recovery: check all pending deposits with no txid for missed BTC arrivals
    async fn recover_pending_deposits(&self) {
        let pending = match self.db.get_by_status(DepositStatus::Pending) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[startup] Failed to load pending deposits: {}", e);
                return;
            }
        };

        let needs_check: Vec<_> = pending.into_iter()
            .filter(|r| r.deposit_txid.is_none())
            .collect();

        if needs_check.is_empty() {
            return;
        }

        println!("[startup] Checking {} pending deposits for missed BTC...", needs_check.len());

        for record in &needs_check {
            if let Err(e) = self.check_and_update_confirmations(&record.taproot_address).await {
                eprintln!("[startup] Error checking {}: {}", record.id, e);
            }
        }
    }

    /// Determine the appropriate status to resume from based on deposit progress
    fn determine_resume_status(&self, record: &DepositRecord) -> DepositStatus {
        if record.sweep_txid.is_some() {
            DepositStatus::SweepConfirming
        } else if record.deposit_txid.is_some() && record.confirmations >= self.config.required_confirmations {
            DepositStatus::Confirmed
        } else if record.deposit_txid.is_some() {
            DepositStatus::Detected
        } else {
            DepositStatus::Pending
        }
    }

    /// Retry failed operations that are eligible for retry
    pub async fn retry_failed_operations(&self) -> Result<u32, TrackerError> {
        let retryable = self.db.get_failed_for_retry(self.config.max_retries)?;
        let mut retried = 0;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        for mut record in retryable {
            if let Some(last_retry) = record.last_retry_at {
                if now - last_retry < self.config.retry_delay_secs {
                    continue;
                }
            }

            let resume_status = self.determine_resume_status(&record);
            record.reset_for_retry(resume_status);
            self.db.update(&record)?;

            println!(
                "[{}] Retrying (attempt {}/{}), resuming from {:?}",
                record.id,
                record.retry_count,
                self.config.max_retries,
                resume_status
            );
            retried += 1;
        }

        Ok(retried)
    }

    /// Get deposits eligible for retry
    pub fn get_failed_deposits(&self) -> Vec<DepositRecord> {
        self.db.get_by_status(DepositStatus::Failed).unwrap_or_default()
    }

    /// Get pending deposits
    pub fn get_pending_deposits(&self) -> Vec<DepositRecord> {
        self.db.get_by_status(DepositStatus::Pending).unwrap_or_default()
    }

    /// Manually retry a specific deposit
    pub fn retry_deposit(&self, id: &str) -> Result<(), TrackerError> {
        let mut record = self.db.get_by_id(id)?
            .ok_or_else(|| TrackerError::NotFound(id.to_string()))?;

        if record.status != DepositStatus::Failed {
            return Err(TrackerError::InvalidCommitment(format!(
                "cannot retry deposit in status {:?}",
                record.status
            )));
        }

        let resume_status = self.determine_resume_status(&record);
        record.reset_for_retry(resume_status);
        self.db.update(&record)?;

        println!("[{}] Manual retry triggered, resuming from {:?}", id, resume_status);

        Ok(())
    }

    /// Detect deposits by scanning new blocks for transactions with 64-byte OP_RETURN
    /// outputs (ephemeralPub + npk). For each candidate, recompute the tweaked Taproot
    /// address from pool_key + H_TapTweak(pool_key || npk) and verify a matching P2TR output.
    pub async fn detect_op_return_deposits(&self) -> Result<u32, TrackerError> {
        let sweeper = match &self.sweeper {
            Some(s) => s,
            None => return Ok(0),
        };

        let pool_pubkey_hex = sweeper.pool_public_key();
        let pool_pubkey_bytes = hex::decode(&pool_pubkey_hex)
            .map_err(|e| TrackerError::InvalidAddress(format!("pool key hex: {}", e)))?;
        let pool_pubkey = bitcoin::XOnlyPublicKey::from_slice(&pool_pubkey_bytes)
            .map_err(|e| TrackerError::InvalidAddress(format!("pool key: {}", e)))?;

        let tip_height = self.watcher.get_tip_height().await?;

        // Initialize last_scanned_height: load from DB, fall back to tip-10
        let last = self.last_scanned_height.load(Ordering::Relaxed);
        if last == 0 {
            if let Ok(Some(stored)) = self.db.get_metadata("last_scanned_height") {
                if let Ok(h) = stored.parse::<u64>() {
                    self.last_scanned_height.store(h, Ordering::Relaxed);
                    println!(
                        "[block-scan] Resumed from persisted height {}, tip is {}",
                        h, tip_height
                    );
                }
            }
            // If still 0 (no DB value), use tip-100 to catch older deposits after fresh deploy
            if self.last_scanned_height.load(Ordering::Relaxed) == 0 {
                let start = tip_height.saturating_sub(100);
                self.last_scanned_height.store(start, Ordering::Relaxed);
                println!(
                    "[block-scan] First run, scanning from block {} to {}",
                    start, tip_height
                );
            }
        }

        let scan_from = self.last_scanned_height.load(Ordering::Relaxed) + 1;
        if scan_from > tip_height {
            return Ok(0); // No new blocks
        }

        let mut total_detected = 0u32;

        for height in scan_from..=tip_height {
            let block_hash = match self.watcher.get_block_hash(height).await {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("[block-scan] Failed to get block hash at {}: {}", height, e);
                    break; // Stop scanning, will retry next cycle
                }
            };

            let detected = self
                .scan_block_for_deposits(&block_hash, height, &pool_pubkey)
                .await?;
            total_detected += detected;

            self.last_scanned_height.store(height, Ordering::Relaxed);
            // Persist to DB so restarts don't re-scan from tip-10
            let _ = self.db.set_metadata("last_scanned_height", &height.to_string());
        }

        if total_detected > 0 {
            println!(
                "[block-scan] Detected {} new deposits in blocks {}-{}",
                total_detected, scan_from, tip_height
            );
        }

        Ok(total_detected)
    }

    /// Scan a single block for deposit transactions with valid OP_RETURN + tweaked P2TR.
    async fn scan_block_for_deposits(
        &self,
        block_hash: &str,
        block_height: u64,
        pool_pubkey: &bitcoin::XOnlyPublicKey,
    ) -> Result<u32, TrackerError> {
        use super::sweeper::extract_deposit_op_return_from_transaction;

        let block_txs = match self.watcher.get_all_block_txs(block_hash).await {
            Ok(txs) => txs,
            Err(e) => {
                eprintln!(
                    "[block-scan] Failed to get txs for block {}: {}",
                    block_hash, e
                );
                return Ok(0);
            }
        };

        let mut detected = 0u32;

        for esplora_tx in &block_txs {
            // Quick pre-filter: look for an OP_RETURN-shaped output in the Esplora JSON
            let has_op_return = esplora_tx.vout.iter().any(|o| {
                o.scriptpubkey_type == "op_return"
            });
            if !has_op_return {
                continue;
            }

            // Fetch raw tx to parse with bitcoin lib
            let tx_hex = match self.watcher.get_tx_hex(&esplora_tx.txid).await {
                Ok(h) => h,
                Err(_) => continue,
            };

            let raw_tx = match hex::decode(tx_hex.trim()) {
                Ok(b) => b,
                Err(_) => continue,
            };

            let parsed_tx: bitcoin::Transaction =
                match bitcoin::consensus::encode::deserialize(&raw_tx) {
                    Ok(t) => t,
                    Err(_) => continue,
                };

            let op_return_data = match extract_deposit_op_return_from_transaction(&parsed_tx) {
                Some(d) => d,
                None => continue,
            };

            // Try to match a P2TR output against pool_key tweaked with npk
            let matched = self.match_deposit_output(
                &parsed_tx,
                &esplora_tx.txid,
                block_height,
                &op_return_data,
                pool_pubkey,
            )?;

            if matched {
                detected += 1;
            }
        }

        Ok(detected)
    }

    /// Check if a transaction's P2TR output matches the expected tweaked address
    /// and register it as a deposit if so.
    fn match_deposit_output(
        &self,
        parsed_tx: &bitcoin::Transaction,
        txid: &str,
        block_height: u64,
        op_return_data: &super::types::DepositOpReturnData,
        pool_pubkey: &bitcoin::XOnlyPublicKey,
    ) -> Result<bool, TrackerError> {
        use super::sweeper::verify_deposit_output;

        let npk_hex = hex::encode(op_return_data.npk);

        // Check if already tracked by npk
        if self.db.get_by_deposit_txid(txid)?.is_some() {
            return Ok(false);
        }

        for (vout, output) in parsed_tx.output.iter().enumerate() {
            let script = output.script_pubkey.as_bytes();
            // P2TR: OP_1 (0x51) + PUSH32 (0x20) + 32 bytes = 34 bytes
            if script.len() != 34 || script[0] != 0x51 || script[1] != 0x20 {
                continue;
            }

            let mut output_key_bytes = [0u8; 32];
            output_key_bytes.copy_from_slice(&script[2..34]);
            let output_key = match bitcoin::XOnlyPublicKey::from_slice(&output_key_bytes) {
                Ok(k) => k,
                Err(_) => continue,
            };

            if !verify_deposit_output(&output_key, pool_pubkey, &op_return_data.npk) {
                continue;
            }

            // Match found — reconstruct Taproot address
            let tweaked =
                bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(output_key);
            let addr =
                bitcoin::Address::p2tr_tweaked(tweaked, bitcoin::Network::Testnet);
            let taproot_address = addr.to_string();

            // Check if already tracked by address
            if self.db.get_by_address(&taproot_address).ok().flatten().is_some() {
                return Ok(false);
            }

            // Auto-register the deposit
            let mut record = DepositRecord::new(
                taproot_address,
                npk_hex.clone(),
                output.value.to_sat(),
            );
            record.ephemeral_pub = Some(hex::encode(op_return_data.ephemeral_pub));
            record.npk = Some(npk_hex.clone());
            record.auto_detected = true;
            record.deposit_txid = Some(txid.to_string());
            record.deposit_vout = Some(vout as u32);
            record.deposit_block_height = Some(block_height);
            // Use update_confirmations so status advances correctly
            // (e.g., Confirmed when confirmations >= required)
            record.update_confirmations(1, Some(block_height));

            if let Err(e) = self.db.insert(&record) {
                eprintln!("[block-scan] Failed to insert deposit: {}", e);
                return Ok(false);
            }

            println!(
                "[{}] Auto-detected deposit via block scan: {} sats, npk={}, block={}",
                record.id,
                output.value.to_sat(),
                &npk_hex[..16],
                block_height
            );
            return Ok(true);
        }

        Ok(false)
    }

    /// Detect deposit from a single mempool transaction (pre-confirmation).
    pub async fn detect_mempool_tx(&self, txid: &str) -> Result<bool, TrackerError> {
        use super::sweeper::{extract_deposit_op_return_from_transaction, verify_deposit_output};

        let sweeper = match &self.sweeper {
            Some(s) => s,
            None => return Ok(false),
        };

        let pool_pubkey_hex = sweeper.pool_public_key();
        let pool_pubkey_bytes = hex::decode(&pool_pubkey_hex)
            .map_err(|e| TrackerError::InvalidAddress(format!("pool key hex: {}", e)))?;
        let pool_pubkey = bitcoin::XOnlyPublicKey::from_slice(&pool_pubkey_bytes)
            .map_err(|e| TrackerError::InvalidAddress(format!("pool key: {}", e)))?;

        // Fetch raw tx
        let tx_hex = match self.watcher.get_tx_hex(txid).await {
            Ok(h) => h,
            Err(_) => return Ok(false),
        };

        let raw_tx = match hex::decode(tx_hex.trim()) {
            Ok(b) => b,
            Err(_) => return Ok(false),
        };

        let parsed_tx: bitcoin::Transaction =
            match bitcoin::consensus::encode::deserialize(&raw_tx) {
                Ok(t) => t,
                Err(_) => return Ok(false),
            };

        let op_return_data = match extract_deposit_op_return_from_transaction(&parsed_tx) {
            Some(d) => d,
            None => return Ok(false),
        };

        let npk_hex = hex::encode(op_return_data.npk);

        // Check if already tracked
        if self.db.get_by_deposit_txid(txid)?.is_some() {
            return Ok(false);
        }

        for (vout, output) in parsed_tx.output.iter().enumerate() {
            let script = output.script_pubkey.as_bytes();
            if script.len() != 34 || script[0] != 0x51 || script[1] != 0x20 {
                continue;
            }

            let mut output_key_bytes = [0u8; 32];
            output_key_bytes.copy_from_slice(&script[2..34]);
            let output_key = match bitcoin::XOnlyPublicKey::from_slice(&output_key_bytes) {
                Ok(k) => k,
                Err(_) => continue,
            };

            if !verify_deposit_output(&output_key, &pool_pubkey, &op_return_data.npk) {
                continue;
            }

            let tweaked = bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(output_key);
            let addr = bitcoin::Address::p2tr_tweaked(tweaked, bitcoin::Network::Testnet);
            let taproot_address = addr.to_string();

            if self.db.get_by_address(&taproot_address).ok().flatten().is_some() {
                return Ok(false);
            }

            let mut record = DepositRecord::new(
                taproot_address,
                npk_hex.clone(),
                output.value.to_sat(),
            );
            record.ephemeral_pub = Some(hex::encode(op_return_data.ephemeral_pub));
            record.npk = Some(npk_hex.clone());
            record.auto_detected = true;
            record.deposit_txid = Some(txid.to_string());
            record.deposit_vout = Some(vout as u32);
            record.status = DepositStatus::Pending; // Not confirmed yet

            if let Err(e) = self.db.insert(&record) {
                eprintln!("[mempool] Failed to insert deposit: {}", e);
                return Ok(false);
            }

            println!(
                "[{}] Detected deposit in mempool: {} sats, npk={}, txid={}",
                record.id,
                output.value.to_sat(),
                &npk_hex[..16],
                &txid[..16]
            );
            return Ok(true);
        }

        Ok(false)
    }

    /// Run the tracker service (blocking)
    pub async fn run(&mut self) -> Result<(), TrackerError> {
        println!("=== Deposit Tracker Service ===");
        println!("Poll interval: {} seconds", self.config.poll_interval_secs);
        println!("Required confirmations: {}", self.config.required_confirmations);
        println!(
            "Required sweep confirmations: {}",
            self.config.required_sweep_confirmations
        );
        println!("Database: {}", self.config.db_path);
        println!("Max retries: {}", self.config.max_retries);
        println!("Detection: block scanning (auto-detect OP_RETURN deposits)");
        println!("WebSocket: {}", if self.config.ws_enabled { &self.config.ws_url } else { "disabled" });
        println!("Header relay: {}", if self.config.header_relay_enabled { "enabled" } else { "disabled" });
        println!();

        // Recover any interrupted deposits
        self.recover_in_progress_deposits().await?;

        // Startup recovery: check pending deposits that may have received BTC while offline
        self.recover_pending_deposits().await;

        // Backfill sweep fees for older deposits missing fee data
        self.backfill_sweep_fees().await;

        // Initialize header relayer (shared between WS listener and verify path)
        self.init_header_relayer();

        // Optionally start the mempool.space WebSocket listener
        let mut ws_event_rx = self.maybe_start_ws_listener();

        let mut poll_interval = interval(Duration::from_secs(self.config.poll_interval_secs));
        let mut retry_interval = interval(Duration::from_secs(self.config.retry_delay_secs));

        loop {
            tokio::select! {
                _ = poll_interval.tick() => {
                    if let Err(e) = self.process_cycle().await {
                        eprintln!("Process cycle error: {}", e);
                    }
                }
                _ = retry_interval.tick() => {
                    if let Err(e) = self.retry_failed_operations().await {
                        eprintln!("Retry cycle error: {}", e);
                    }
                }
                Some(event) = async {
                    match ws_event_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending::<Option<WsEvent>>().await,
                    }
                } => {
                    self.handle_ws_event(event).await;
                }
            }
        }
    }

    /// Initialize the header relayer (shared between WS listener and verify path)
    fn init_header_relayer(&mut self) {
        if self.header_relayer.is_some() {
            return;
        }
        if self.config.header_relay_enabled && !self.config.relayer_keypair.is_empty() {
            match self.create_header_relayer() {
                Ok(r) => {
                    println!("[ws] Header relayer configured");
                    let relayer = Arc::new(r);
                    // Initial sync — catch up any gap accumulated while offline
                    let r2 = Arc::clone(&relayer);
                    tokio::spawn(async move {
                        match r2.sync_headers().await {
                            Ok(n) if n > 0 => println!("[header-relay] Initial sync: relayed {} headers", n),
                            Ok(_) => println!("[header-relay] Initial sync: already at tip"),
                            Err(e) => eprintln!("[header-relay] Initial sync error: {}", e),
                        }
                    });
                    self.header_relayer = Some(relayer);
                }
                Err(e) => {
                    eprintln!("[ws] Header relayer failed: {}, continuing without", e);
                }
            }
        }
    }

    /// Start WebSocket listener if enabled, returns event receiver
    fn maybe_start_ws_listener(&self) -> Option<mpsc::UnboundedReceiver<WsEvent>> {
        if !self.config.ws_enabled {
            return None;
        }

        let (event_tx, event_rx) = mpsc::unbounded_channel::<WsEvent>();

        let listener = MempoolWsListener::new(&self.config, event_tx, self.header_relayer.clone());
        tokio::spawn(async move { listener.run().await });

        Some(event_rx)
    }

    fn create_header_relayer(&self) -> Result<HeaderRelayer, String> {
        let keypair = if self.config.relayer_keypair.starts_with('[') {
            let bytes: Vec<u8> = serde_json::from_str(&self.config.relayer_keypair)
                .map_err(|e| format!("parse keypair JSON: {}", e))?;
            Keypair::try_from(bytes.as_slice()).map_err(|e| format!("invalid keypair: {}", e))?
        } else {
            crate::load_keypair_from_file(&self.config.relayer_keypair)
                .map_err(|e| format!("load keypair: {}", e))?
        };

        HeaderRelayer::new(
            &self.config.solana_rpc,
            &self.config.esplora_url,
            &self.config.btc_light_client_program_id,
            keypair,
            self.config.header_batch_size,
        )
        .map_err(|e| e.to_string())
    }

    async fn handle_ws_event(&self, event: WsEvent) {
        match event {
            WsEvent::NewBlock { height, .. } => {
                println!("[ws] Block {}, scanning for deposits...", height);
                if let Err(e) = self.process_cycle().await {
                    eprintln!("[ws] Process cycle error: {}", e);
                }
            }
            WsEvent::Connected => println!("[ws] Connected - real-time block detection active"),
            WsEvent::Disconnected => println!("[ws] Disconnected - falling back to polling"),
        }
    }

    /// Run a single processing cycle
    pub async fn process_cycle(&self) -> Result<(), TrackerError> {
        // Scan for new OP_RETURN deposits before processing existing ones
        if let Err(e) = self.detect_op_return_deposits().await {
            eprintln!("[OP_RETURN] Detection error: {}", e);
        }

        // Get all active deposits from database
        let deposits = self.db.get_active()?;

        for record in deposits {
            if let Err(e) = self.process_deposit(&record.taproot_address).await {
                eprintln!("Error processing deposit {}: {}", record.id, e);

                // Mark as failed for certain errors
                if let Some(mut record) = self.db.get_by_address(&record.taproot_address)? {
                    if !matches!(
                        record.status,
                        DepositStatus::Claimed | DepositStatus::Failed
                    ) {
                        match &e {
                            TrackerError::Sweeper(_) | TrackerError::Verifier(_) => {
                                record.mark_failed(e.to_string());
                                self.db.update(&record)?;
                                self.publish_update(&record).await;
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        Ok(())
    }

    /// Process a single deposit
    async fn process_deposit(&self, address: &str) -> Result<(), TrackerError> {
        let record = self.db.get_by_address(address)?
            .ok_or_else(|| TrackerError::NotFound(address.to_string()))?;

        match record.status {
            DepositStatus::Pending | DepositStatus::Detected | DepositStatus::Confirming => {
                self.check_and_update_confirmations(address).await?;
            }
            DepositStatus::Confirmed => {
                self.sweep_deposit(address, &record.commitment).await?;
            }
            DepositStatus::Sweeping => {
                // Waiting for sweep tx broadcast - handled in sweep_deposit
            }
            DepositStatus::SweepConfirming => {
                self.check_sweep_confirmations(address).await?;
            }
            DepositStatus::Verifying => {
                self.check_verification_status(address).await?;
            }
            DepositStatus::Ready | DepositStatus::Claimed | DepositStatus::Failed => {
                // Terminal states - nothing to do
            }
        }

        // Publish update after processing
        if let Some(record) = self.db.get_by_address(address)? {
            self.publish_update(&record).await;
        }

        Ok(())
    }

    /// Check address for deposits and update confirmation count.
    /// For pending deposits with no txid, also checks mempool for unconfirmed txs.
    async fn check_and_update_confirmations(&self, address: &str) -> Result<(), TrackerError> {
        let mut record = self.db.get_by_address(address)?
            .ok_or_else(|| TrackerError::NotFound(address.to_string()))?;

        // If no deposit txid yet, check mempool first for early detection
        if record.deposit_txid.is_none() {
            match self.watcher.get_address_mempool_txs(address).await {
                Ok(mempool_txs) => {
                    for tx in &mempool_txs {
                        // Find the output paying to this address
                        for (vout_idx, vout) in tx.vout.iter().enumerate() {
                            if vout.scriptpubkey_address.as_deref() == Some(address) {
                                record.mark_detected(tx.txid.clone(), vout_idx as u32);
                                record.amount_sats = vout.value;
                                self.db.update(&record)?;
                                println!(
                                    "[{}] Deposit detected in mempool: {} ({} sats)",
                                    record.id, tx.txid, vout.value
                                );
                                break;
                            }
                        }
                        if record.deposit_txid.is_some() {
                            break;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[{}] Mempool check failed: {}", record.id, e);
                }
            }
        }

        let addr_status = self.watcher.check_address(address).await?;

        if addr_status.utxos.is_empty() {
            // UTXO already spent — check if it was swept externally (e.g., by FROST)
            let mut record = self.db.get_by_address(address)?
                .ok_or_else(|| TrackerError::NotFound(address.to_string()))?;

            if record.sweep_txid.is_none() {
                if let (Some(ref dep_txid), Some(dep_vout)) = (&record.deposit_txid, record.deposit_vout) {
                    if let Some((sweep_txid, fee)) = self.check_external_sweep(dep_txid, dep_vout).await {
                        println!(
                            "[{}] External sweep detected: {} (fee: {} sats)",
                            record.id, sweep_txid, fee
                        );
                        record.mark_sweep_broadcast(sweep_txid, self.config.pool_receive_address.clone(), fee);
                        self.db.update(&record)?;
                    }
                }
            }

            return Ok(());
        }

        let utxo = addr_status.utxos[0].clone();

        // Re-read record in case mempool check updated it
        let mut record = self.db.get_by_address(address)?
            .ok_or_else(|| TrackerError::NotFound(address.to_string()))?;

        if record.deposit_txid.is_none() {
            record.mark_detected(utxo.txid.clone(), utxo.vout);
            println!(
                "[{}] Deposit detected: {} ({} sats)",
                record.id, utxo.txid, utxo.value
            );

            if record.amount_sats != utxo.value {
                record.amount_sats = utxo.value;
            }
        }

        let old_status = record.status;
        record.update_confirmations(utxo.confirmations, utxo.block_height);
        let new_status = record.status;

        // Check if enough confirmations
        if utxo.confirmations >= self.config.required_confirmations
            && record.status != DepositStatus::Confirmed
        {
            record.status = DepositStatus::Confirmed;
        }

        self.db.update(&record)?;

        if new_status != old_status || record.status == DepositStatus::Confirmed {
            println!(
                "[{}] Status: {:?} → {:?} ({} confirmations)",
                record.id, old_status, record.status, utxo.confirmations
            );
        }

        Ok(())
    }

    /// Sweep deposit UTXO to pool wallet
    async fn sweep_deposit(&self, address: &str, commitment: &str) -> Result<(), TrackerError> {
        let sweeper = match &self.sweeper {
            Some(s) => s,
            None => {
                eprintln!("Sweeper not configured, skipping sweep");
                return Ok(());
            }
        };

        let mut record = self.db.get_by_address(address)?
            .ok_or_else(|| TrackerError::NotFound(address.to_string()))?;

        record.mark_sweeping();
        self.db.update(&record)?;
        println!("[{}] Sweeping UTXO to pool wallet...", record.id);

        // For npk-based deposits, register DepositIntent PDA before sweep
        if let (Some(ref ephemeral_pub), Some(ref npk)) = (&record.ephemeral_pub, &record.npk) {
            if let Some(verifier) = &self.verifier {
                println!("[{}] Registering DepositIntent PDA (npk-based deposit)...", record.id);
                match verifier.register_deposit_intent(ephemeral_pub, npk).await {
                    Ok(sig) => {
                        if sig.is_empty() {
                            println!("[{}] DepositIntent PDA already exists (idempotent)", record.id);
                        } else {
                            println!("[{}] DepositIntent PDA registered: {}", record.id, sig);
                        }
                    }
                    Err(e) => {
                        eprintln!("[{}] Failed to register DepositIntent PDA: {}", record.id, e);
                        // Continue with sweep anyway — v2 verify will fail if PDA missing
                    }
                }
            }
        }

        match sweeper
            .sweep_utxo(address, commitment, self.config.required_confirmations)
            .await
        {
            Ok(result) => {
                record.mark_sweep_broadcast(result.txid.clone(), result.pool_address, result.fee_sats);
                self.db.update(&record)?;
                println!(
                    "[{}] Sweep broadcast: {} (fee: {} sats)",
                    record.id, result.txid, result.fee_sats
                );
            }
            Err(super::sweeper::SweeperError::NoUtxo) => {
                // UTXO already spent — check if swept externally (e.g., by FROST)
                if let (Some(ref dep_txid), Some(dep_vout)) = (&record.deposit_txid, record.deposit_vout) {
                    if let Some((sweep_txid, fee)) = self.check_external_sweep(dep_txid, dep_vout).await {
                        println!(
                            "[{}] External sweep detected: {} (fee: {} sats)",
                            record.id, sweep_txid, fee
                        );
                        record.mark_sweep_broadcast(sweep_txid, self.config.pool_receive_address.clone(), fee);
                        self.db.update(&record)?;
                        return Ok(());
                    }
                }
                return Err(super::sweeper::SweeperError::NoUtxo.into());
            }
            Err(e) => return Err(e.into()),
        }

        Ok(())
    }

    /// Check sweep transaction confirmations
    async fn check_sweep_confirmations(&self, address: &str) -> Result<(), TrackerError> {
        let record = self.db.get_by_address(address)?
            .ok_or_else(|| TrackerError::NotFound(address.to_string()))?;

        let sweep_txid = match &record.sweep_txid {
            Some(txid) => txid.clone(),
            None => return Ok(()),
        };

        let record_id = record.id.clone();
        let deposit_txid = record.deposit_txid.clone().unwrap_or_default();

        let tx_status = self.watcher.get_tx_confirmations(&sweep_txid).await?;

        let mut record = self.db.get_by_address(address)?
            .ok_or_else(|| TrackerError::NotFound(address.to_string()))?;

        record.update_sweep_confirmations(tx_status.confirmations, tx_status.block_height);
        self.db.update(&record)?;

        println!(
            "[{}] Sweep confirmations: {}",
            record_id, tx_status.confirmations
        );

        if record.can_verify() {
            self.verify_deposit(address, &sweep_txid, &deposit_txid).await?;
        }

        Ok(())
    }

    /// Submit deposit for SPV verification (trustless npk extraction)
    async fn verify_deposit(
        &self,
        address: &str,
        sweep_txid: &str,
        deposit_txid: &str,
    ) -> Result<(), TrackerError> {
        let verifier = match &self.verifier {
            Some(v) => v,
            None => {
                eprintln!("Verifier not configured, skipping verification");
                return Ok(());
            }
        };

        let mut record = self.db.get_by_address(address)?
            .ok_or_else(|| TrackerError::NotFound(address.to_string()))?;

        let record_id = record.id.clone();

        // Check if block header is available — trigger on-demand relay if missing
        if let Some(block_height) = record.sweep_block_height {
            if !verifier.block_header_available(block_height).await? {
                // Try to sync headers on-demand (covers WS disconnect gaps)
                if let Some(relayer) = &self.header_relayer {
                    println!(
                        "[{}] Block {} header missing, triggering on-demand header sync...",
                        record_id, block_height
                    );
                    match relayer.sync_headers().await {
                        Ok(n) if n > 0 => {
                            println!("[{}] On-demand relay: synced {} headers", record_id, n);
                        }
                        Ok(_) => {}
                        Err(e) => {
                            eprintln!("[{}] On-demand header relay failed: {}", record_id, e);
                        }
                    }
                    // Re-check after sync attempt
                    if !verifier.block_header_available(block_height).await? {
                        println!(
                            "[{}] Still waiting for block {} after sync attempt",
                            record_id, block_height
                        );
                        return Ok(());
                    }
                } else {
                    println!(
                        "[{}] Waiting for header-relayer to sync block {}",
                        record_id, block_height
                    );
                    return Ok(());
                }
            }
        }

        if verifier.is_already_verified(deposit_txid).await? {
            println!("[{}] Already verified on Solana (deposit receipt exists)", record_id);
            record.mark_ready("already_verified".to_string(), 0);
            self.db.update(&record)?;
            return Ok(());
        }

        record.mark_verifying();
        self.db.update(&record)?;

        // Route to v2 verification if deposit has npk (npk-based, no deposit ChadBuffer needed)
        let result = if let Some(ref npk) = record.npk {
            println!("[{}] Submitting SPV verification (v2, npk-based)...", record_id);
            verifier
                .verify_deposit_v2(sweep_txid, deposit_txid, npk)
                .await?
        } else {
            println!("[{}] Submitting SPV verification...", record_id);
            verifier
                .verify_deposit(sweep_txid, deposit_txid)
                .await?
        };

        let mut record = self.db.get_by_address(address)?
            .ok_or_else(|| TrackerError::NotFound(address.to_string()))?;

        record.mark_ready(result.solana_tx.clone(), result.leaf_index);
        self.db.update(&record)?;

        println!(
            "[{}] Verified! Solana TX: {}, Leaf index: {}",
            record_id, result.solana_tx, result.leaf_index
        );

        Ok(())
    }

    /// Check verification status (for deposits in Verifying state)
    async fn check_verification_status(&self, _address: &str) -> Result<(), TrackerError> {
        Ok(())
    }

    /// Publish status update via WebSocket
    async fn publish_update(&self, record: &DepositRecord) {
        if let Some(publisher) = &self.publisher {
            publisher.publish_deposit_status(record).await;
        }
    }

    /// Backfill sweep_fee_sats for deposits that were swept but missing fee data.
    /// Fetches the sweep transaction from Esplora to get the fee.
    async fn backfill_sweep_fees(&self) {
        let records = match self.db.get_all() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[backfill] Failed to load deposits: {}", e);
                return;
            }
        };

        let mut updated = 0;
        for mut record in records {
            // Only backfill if sweep happened but fee is missing
            if record.sweep_txid.is_some() && record.sweep_fee_sats.is_none() {
                let sweep_txid = record.sweep_txid.as_ref().unwrap().clone();
                match self.watcher.get_tx(&sweep_txid).await {
                    Ok(tx) => {
                        record.sweep_fee_sats = Some(tx.fee);
                        if let Err(e) = self.db.update(&record) {
                            eprintln!("[backfill] Failed to update {}: {}", record.id, e);
                        } else {
                            println!(
                                "[backfill] {} sweep_fee_sats={} (minted={})",
                                record.id, tx.fee, record.amount_sats.saturating_sub(tx.fee)
                            );
                            updated += 1;
                        }
                    }
                    Err(e) => {
                        eprintln!("[backfill] Failed to fetch sweep tx {}: {}", sweep_txid, e);
                    }
                }
            }
        }

        if updated > 0 {
            println!("[backfill] Updated {} deposits with sweep fees", updated);
        }
    }

    /// Mark deposit as claimed (called by claim handler)
    pub fn mark_claimed(&self, id: &str) -> Result<(), TrackerError> {
        let mut record = self.db.get_by_id(id)?
            .ok_or_else(|| TrackerError::NotFound(id.to_string()))?;

        if record.status != DepositStatus::Ready {
            return Err(TrackerError::InvalidCommitment(format!(
                "cannot claim deposit in status {:?}",
                record.status
            )));
        }

        record.mark_claimed();
        self.db.update(&record)?;

        Ok(())
    }
}

/// Shared service type for API handlers
pub type SharedTrackerService = Arc<RwLock<DepositTrackerService>>;

/// Create shared tracker service
pub fn create_tracker_service(config: TrackerConfig) -> SharedTrackerService {
    Arc::new(RwLock::new(DepositTrackerService::new_testnet(config)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> TrackerConfig {
        TrackerConfig {
            db_path: ":memory:".to_string(),
            ..TrackerConfig::default()
        }
    }

    #[test]
    fn test_get_nonexistent_deposit() {
        let config = test_config();
        let service = DepositTrackerService::new_testnet(config);

        assert!(service.get_deposit("nonexistent").is_none());
    }

    #[test]
    fn test_stats_empty() {
        let config = test_config();
        let service = DepositTrackerService::new_testnet(config);

        let stats = service.stats();
        assert_eq!(stats.total_deposits, 0);
    }
}
