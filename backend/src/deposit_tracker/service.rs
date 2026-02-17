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
//! 5. User can claim zBTC once status is "ready"
//!
//! # Persistence:
//! Uses SQLite for durable storage. Service can restart and resume processing.

use solana_sdk::signature::Keypair;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{interval, Duration};

use super::sqlite_db::{SqliteDepositStore, SqliteError};
use super::sweeper::{SweeperError, UtxoSweeper};
use super::types::{DepositRecord, DepositStatus, TrackerConfig, TrackerStats};
use super::verifier::{SpvVerifier, VerifierError};
use super::watcher::{AddressWatcher, WatcherError};
use super::websocket::{DepositUpdatePublisher, SharedWebSocketState};

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
}

impl DepositTrackerService {
    /// Create a new tracker service for testnet with SQLite persistence
    pub fn new_testnet(config: TrackerConfig) -> Self {
        let db = SqliteDepositStore::new(&config.db_path)
            .expect("Failed to initialize SQLite database");
        let watcher = AddressWatcher::testnet();

        Self {
            config,
            db,
            watcher,
            sweeper: None,
            verifier: None,
            publisher: None,
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

    /// Set up verifier with Solana keypair
    pub fn with_verifier(mut self, keypair: Keypair) -> Self {
        let mut verifier = SpvVerifier::new_testnet(&self.config.solana_rpc);
        verifier.set_payer(keypair);
        self.verifier = Some(verifier);
        self
    }

    /// Set up WebSocket publisher
    pub fn with_websocket(mut self, ws_state: SharedWebSocketState) -> Self {
        self.publisher = Some(DepositUpdatePublisher::new(ws_state));
        self
    }

    /// Register a new deposit to track
    pub fn register_deposit(
        &self,
        taproot_address: String,
        commitment: String,
        amount_sats: u64,
    ) -> Result<String, TrackerError> {
        // Validate commitment format
        if commitment.len() != 64 {
            return Err(TrackerError::InvalidCommitment(format!(
                "wrong length: {} != 64",
                commitment.len()
            )));
        }

        // Check for duplicate
        if self.db.get_by_address(&taproot_address)?.is_some() {
            return Err(TrackerError::Duplicate(taproot_address));
        }

        // Create new record
        let record = DepositRecord::new(taproot_address, commitment, amount_sats);
        let id = record.id.clone();

        // Store in database
        self.db.insert(&record)?;

        println!("[{}] Deposit registered, watching for BTC", id);

        Ok(id)
    }

    /// Get deposit by ID
    pub fn get_deposit(&self, id: &str) -> Option<DepositRecord> {
        self.db.get_by_id(id).ok().flatten()
    }

    /// Get deposit by address
    pub fn get_deposit_by_address(&self, address: &str) -> Option<DepositRecord> {
        self.db.get_by_address(address).ok().flatten()
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

    /// Recover in-progress deposits after service restart
    ///
    /// Finds deposits that were interrupted mid-processing and resets them
    /// to an appropriate state to resume.
    pub fn recover_in_progress_deposits(&self) -> Result<u32, TrackerError> {
        let active = self.db.get_active()?;
        let mut recovered = 0;

        for mut record in active {
            let should_reset = match record.status {
                // These mid-operation states should be reset
                DepositStatus::Sweeping => {
                    // Was in the middle of sweeping - check if sweep actually happened
                    if record.sweep_txid.is_none() {
                        record.status = DepositStatus::Confirmed;
                        true
                    } else {
                        record.status = DepositStatus::SweepConfirming;
                        true
                    }
                }
                DepositStatus::Verifying => {
                    // Was verifying - reset to sweep confirming to re-verify
                    record.status = DepositStatus::SweepConfirming;
                    true
                }
                _ => false,
            };

            if should_reset {
                record.error = None;
                self.db.update(&record)?;
                println!(
                    "[{}] Recovered interrupted deposit, reset to {:?}",
                    record.id, record.status
                );
                recovered += 1;
            }
        }

        if recovered > 0 {
            println!("Recovered {} interrupted deposits", recovered);
        }

        Ok(recovered)
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

    /// Run the tracker service (blocking)
    pub async fn run(&self) -> Result<(), TrackerError> {
        println!("=== Deposit Tracker Service ===");
        println!("Poll interval: {} seconds", self.config.poll_interval_secs);
        println!("Required confirmations: {}", self.config.required_confirmations);
        println!(
            "Required sweep confirmations: {}",
            self.config.required_sweep_confirmations
        );
        println!("Database: {}", self.config.db_path);
        println!("Max retries: {}", self.config.max_retries);
        println!();

        // Recover any interrupted deposits
        self.recover_in_progress_deposits()?;

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
            }
        }
    }

    /// Run a single processing cycle
    pub async fn process_cycle(&self) -> Result<(), TrackerError> {
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

    /// Check address for deposits and update confirmation count
    async fn check_and_update_confirmations(&self, address: &str) -> Result<(), TrackerError> {
        let addr_status = self.watcher.check_address(address).await?;

        if addr_status.utxos.is_empty() {
            return Ok(());
        }

        let utxo = addr_status.utxos[0].clone();

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

        let result = sweeper
            .sweep_utxo(address, commitment, self.config.required_confirmations)
            .await?;

        record.mark_sweep_broadcast(result.txid.clone(), result.pool_address);
        self.db.update(&record)?;

        println!(
            "[{}] Sweep broadcast: {} (fee: {} sats)",
            record.id, result.txid, result.fee_sats
        );

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
        let commitment = record.commitment.clone();

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
            self.verify_deposit(address, &sweep_txid, &commitment).await?;
        }

        Ok(())
    }

    /// Submit deposit for SPV verification
    async fn verify_deposit(
        &self,
        address: &str,
        sweep_txid: &str,
        commitment: &str,
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

        let amount_sats = record.amount_sats;
        let record_id = record.id.clone();

        // Check if block header is available
        if let Some(block_height) = record.sweep_block_height {
            if !verifier.block_header_available(block_height).await? {
                println!(
                    "[{}] Waiting for header-relayer to sync block {}",
                    record_id, block_height
                );
                return Ok(());
            }
        }

        if verifier.is_already_verified(sweep_txid).await? {
            println!("[{}] Already verified on Solana", record_id);
            record.mark_ready("already_verified".to_string(), 0);
            self.db.update(&record)?;
            return Ok(());
        }

        record.mark_verifying();
        self.db.update(&record)?;
        println!("[{}] Submitting SPV verification...", record_id);

        let result = verifier
            .verify_deposit(sweep_txid, 0, commitment, amount_sats)
            .await?;

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
    fn test_register_deposit() {
        let config = test_config();
        let service = DepositTrackerService::new_testnet(config);

        let id = service
            .register_deposit(
                "tb1p123abc".to_string(),
                "a".repeat(64),
                100_000,
            )
            .unwrap();

        assert!(id.starts_with("dep_"));

        let record = service.get_deposit(&id).unwrap();
        assert_eq!(record.status, DepositStatus::Pending);
        assert_eq!(record.amount_sats, 100_000);
    }

    #[test]
    fn test_duplicate_registration() {
        let config = test_config();
        let service = DepositTrackerService::new_testnet(config);

        service
            .register_deposit("tb1p123".to_string(), "b".repeat(64), 50_000)
            .unwrap();

        let result = service.register_deposit("tb1p123".to_string(), "c".repeat(64), 60_000);
        assert!(matches!(result, Err(TrackerError::Duplicate(_))));
    }

    #[test]
    fn test_invalid_commitment() {
        let config = test_config();
        let service = DepositTrackerService::new_testnet(config);

        let result = service.register_deposit("tb1p456".to_string(), "abc".to_string(), 10_000);
        assert!(matches!(result, Err(TrackerError::InvalidCommitment(_))));
    }

    #[test]
    fn test_stats() {
        let config = test_config();
        let service = DepositTrackerService::new_testnet(config);

        service.register_deposit("tb1p1".to_string(), "a".repeat(64), 100_000).unwrap();
        service.register_deposit("tb1p2".to_string(), "b".repeat(64), 200_000).unwrap();

        let stats = service.stats();
        assert_eq!(stats.total_deposits, 2);
        assert_eq!(stats.pending, 2);
    }
}
