//! Redemption Service
//!
//! Main service that processes zBTC burns and triggers BTC withdrawals.

use std::sync::Arc;
use tokio::sync::RwLock;

use crate::esplora::EsploraClient;
use crate::redemption::builder::TxBuilder;
use crate::redemption::queue::WithdrawalQueue;
use crate::redemption::signer::{SingleKeySigner, TxSigner};
use crate::redemption::types::*;
use crate::redemption::watcher::BurnWatcher;

/// Redemption service
pub struct RedemptionService {
    /// Configuration
    config: RedemptionConfig,

    /// Burn event watcher
    watcher: Arc<RwLock<BurnWatcher>>,

    /// Withdrawal queue
    queue: WithdrawalQueue,

    /// Transaction builder
    builder: TxBuilder,

    /// Transaction signer
    signer: Arc<dyn TxSigner>,

    /// Esplora client for broadcasting
    esplora: EsploraClient,

    /// Pool UTXOs (simplified for POC)
    pool_utxos: Arc<RwLock<Vec<PoolUtxo>>>,

    /// Statistics
    stats: Arc<RwLock<RedemptionStats>>,

    /// Running flag
    running: Arc<RwLock<bool>>,
}

impl RedemptionService {
    /// Create a new redemption service with single-key signer
    pub fn new_with_signer(config: RedemptionConfig, signer: SingleKeySigner) -> Self {
        Self {
            watcher: Arc::new(RwLock::new(BurnWatcher::new_devnet())),
            queue: WithdrawalQueue::default(),
            builder: TxBuilder::new_testnet(),
            signer: Arc::new(signer),
            esplora: EsploraClient::new_testnet(),
            pool_utxos: Arc::new(RwLock::new(Vec::new())),
            stats: Arc::new(RwLock::new(RedemptionStats::default())),
            running: Arc::new(RwLock::new(false)),
            config,
        }
    }

    /// Create with generated signer (for testing)
    pub fn new_testnet() -> Self {
        let signer = SingleKeySigner::generate();
        Self::new_with_signer(RedemptionConfig::default(), signer)
    }

    /// Submit a withdrawal request
    pub async fn submit_withdrawal(
        &self,
        solana_burn_tx: String,
        user_solana_address: String,
        amount_sats: u64,
        btc_address: String,
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
        let request = WithdrawalRequest::new(
            solana_burn_tx,
            user_solana_address,
            amount_sats,
            btc_address,
        );

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

    /// Process a single pending withdrawal
    pub async fn process_withdrawal(&self, id: &str) -> Result<ProcessResult, ServiceError> {
        // Get request
        let mut request = self
            .queue
            .get(id)
            .await
            .ok_or_else(|| ServiceError::NotFound(id.to_string()))?;

        // Get available UTXOs
        let utxos = self.pool_utxos.read().await.clone();

        if utxos.is_empty() {
            return Err(ServiceError::NoUtxos);
        }

        // Update status to building
        request.mark_building();
        self.queue.update(request.clone()).await.ok();

        // Build transaction
        let unsigned = self
            .builder
            .build_withdrawal(&request, &utxos)
            .map_err(|e| ServiceError::BuildError(e.to_string()))?;

        // Update status to signing
        request.mark_signing();
        self.queue.update(request.clone()).await.ok();

        // Sign transaction
        let signed_tx = self
            .signer
            .sign(&unsigned)
            .map_err(|e| ServiceError::SignError(e.to_string()))?;

        // Serialize for broadcasting
        let tx_hex = bitcoin::consensus::encode::serialize_hex(&signed_tx);
        let txid = signed_tx.compute_txid().to_string();

        // Update status to broadcasting
        request.mark_broadcasting();
        self.queue.update(request.clone()).await.ok();

        // Broadcast (simulated for POC)
        // In production: self.esplora.broadcast_tx(&tx_hex).await?
        println!("=== Broadcasting Transaction (Simulated) ===");
        println!("TXID: {}", txid);
        println!("Size: {} bytes", tx_hex.len() / 2);
        println!("Fee: {} sats", unsigned.fee);

        // Update status to confirming
        request.mark_confirming(txid.clone());
        self.queue.update(request.clone()).await.ok();

        // Update stats
        let mut stats = self.stats.write().await;
        stats.pending = stats.pending.saturating_sub(1);
        stats.processing += 1;
        stats.total_sats_withdrawn += request.amount_sats;
        stats.total_fees_paid += unsigned.fee;

        Ok(ProcessResult {
            request_id: id.to_string(),
            btc_txid: txid,
            tx_hex,
            fee: unsigned.fee,
        })
    }

    /// Check confirming transactions and mark complete
    pub async fn check_confirmations(&self) -> Result<Vec<String>, ServiceError> {
        let mut completed = Vec::new();
        let confirming = self.queue.get_by_status(WithdrawalStatus::Confirming).await;

        for mut request in confirming {
            if let Some(ref txid) = request.btc_txid {
                // Check confirmations
                match self.esplora.get_confirmations(txid).await {
                    Ok(confs) if confs >= self.config.required_confirmations => {
                        request.mark_complete(confs);
                        self.queue.update(request.clone()).await.ok();
                        completed.push(request.id.clone());

                        // Update stats
                        let mut stats = self.stats.write().await;
                        stats.processing = stats.processing.saturating_sub(1);
                        stats.complete += 1;
                    }
                    Ok(confs) => {
                        // Update confirmation count
                        request.btc_confirmations = confs;
                        self.queue.update(request).await.ok();
                    }
                    Err(e) => {
                        eprintln!("Error checking confirmations for {}: {}", txid, e);
                    }
                }
            }
        }

        Ok(completed)
    }

    /// Process all pending withdrawals
    pub async fn process_all_pending(&self) -> Result<Vec<ProcessResult>, ServiceError> {
        let pending = self.queue.get_pending().await;
        let mut results = Vec::new();

        for request in pending {
            match self.process_withdrawal(&request.id).await {
                Ok(result) => results.push(result),
                Err(e) => {
                    eprintln!("Error processing {}: {}", request.id, e);

                    // Mark as failed
                    if let Some(mut req) = self.queue.get(&request.id).await {
                        req.mark_failed(e.to_string());
                        self.queue.update(req).await.ok();

                        let mut stats = self.stats.write().await;
                        stats.pending = stats.pending.saturating_sub(1);
                        stats.failed += 1;
                    }
                }
            }
        }

        Ok(results)
    }

    /// Run one tick of the service
    pub async fn tick(&self) -> Result<TickResult, ServiceError> {
        let mut result = TickResult::default();

        // Check for burn events
        let burns = self.watcher.write().await.check_burns().await.ok().unwrap_or_default();
        result.burns_detected = burns.len();

        // Convert burns to withdrawal requests
        for burn in burns {
            match self
                .submit_withdrawal(burn.signature, burn.user, burn.amount, burn.btc_address)
                .await
            {
                Ok(_) => result.requests_created += 1,
                Err(e) => eprintln!("Error creating withdrawal from burn: {}", e),
            }
        }

        // Process pending withdrawals
        let processed = self.process_all_pending().await?;
        result.withdrawals_processed = processed.len();

        // Check confirmations
        let completed = self.check_confirmations().await?;
        result.withdrawals_completed = completed.len();

        Ok(result)
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

            tokio::time::sleep(tokio::time::Duration::from_secs(
                self.config.check_interval_secs,
            ))
            .await;
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
    pub burns_detected: usize,
    pub requests_created: usize,
    pub withdrawals_processed: usize,
    pub withdrawals_completed: usize,
}

impl TickResult {
    pub fn has_activity(&self) -> bool {
        self.burns_detected > 0
            || self.requests_created > 0
            || self.withdrawals_processed > 0
            || self.withdrawals_completed > 0
    }
}

impl std::fmt::Display for TickResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "burns: {}, created: {}, processed: {}, completed: {}",
            self.burns_detected,
            self.requests_created,
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
            )
            .await;

        assert!(matches!(result, Err(ServiceError::AmountTooSmall { .. })));
    }
}
