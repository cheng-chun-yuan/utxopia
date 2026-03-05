//! Deposit Tracker Types
//!
//! Types for tracking Bitcoin deposits through their lifecycle:
//! pending → detected → confirming → confirmed → sweeping → sweep_confirming → verifying → ready → claimed

use serde::{Deserialize, Serialize};

/// Status of a deposit through its lifecycle
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DepositStatus {
    /// Waiting for BTC deposit to appear
    Pending,
    /// BTC transaction seen in mempool
    Detected,
    /// 0 confirmations on deposit tx
    Confirming,
    /// 1+ confirmations, ready to sweep
    Confirmed,
    /// Creating and broadcasting sweep tx to pool wallet
    Sweeping,
    /// Waiting for 6 confirmations on sweep tx
    SweepConfirming,
    /// Submitting sweep tx for SPV verification on Solana
    Verifying,
    /// Verified on Solana, can claim zkBTC
    Ready,
    /// zkBTC minted
    Claimed,
    /// Error occurred
    Failed,
}

impl Default for DepositStatus {
    fn default() -> Self {
        Self::Pending
    }
}

impl std::fmt::Display for DepositStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::Pending => "pending",
            Self::Detected => "detected",
            Self::Confirming => "confirming",
            Self::Confirmed => "confirmed",
            Self::Sweeping => "sweeping",
            Self::SweepConfirming => "sweep_confirming",
            Self::Verifying => "verifying",
            Self::Ready => "ready",
            Self::Claimed => "claimed",
            Self::Failed => "failed",
        };
        write!(f, "{}", s)
    }
}

impl std::str::FromStr for DepositStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pending" => Ok(Self::Pending),
            "detected" => Ok(Self::Detected),
            "confirming" => Ok(Self::Confirming),
            "confirmed" => Ok(Self::Confirmed),
            "sweeping" => Ok(Self::Sweeping),
            "sweep_confirming" => Ok(Self::SweepConfirming),
            "verifying" => Ok(Self::Verifying),
            "ready" => Ok(Self::Ready),
            "claimed" => Ok(Self::Claimed),
            "failed" => Ok(Self::Failed),
            _ => Err(format!("unknown status: {}", s)),
        }
    }
}

/// Parsed data from a 64-byte deposit OP_RETURN output (npk-based)
#[derive(Debug, Clone)]
pub struct DepositOpReturnData {
    /// Ed25519 ephemeral public key (32 bytes)
    pub ephemeral_pub: [u8; 32],
    /// Note public key: npk = Poseidon(MPK, stealthScalar) (32 bytes)
    pub npk: [u8; 32],
}

/// A deposit record tracking a single Bitcoin deposit through its lifecycle
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepositRecord {
    /// Unique deposit ID
    pub id: String,
    /// Taproot address for this deposit
    pub taproot_address: String,
    /// The SHA256(nullifier || secret) commitment (hex, 32 bytes)
    pub commitment: String,
    /// Amount in satoshis
    pub amount_sats: u64,
    /// Current status
    pub status: DepositStatus,
    /// Number of confirmations on deposit tx
    pub confirmations: u32,

    // Original deposit transaction
    /// Bitcoin transaction ID of user's deposit
    pub deposit_txid: Option<String>,
    /// Output index in the deposit transaction
    pub deposit_vout: Option<u32>,
    /// Block height of deposit confirmation
    pub deposit_block_height: Option<u64>,

    // Sweep transaction (spends to pool wallet)
    /// Transaction ID of the sweep tx (this is used for SPV)
    pub sweep_txid: Option<String>,
    /// Confirmations on the sweep tx
    pub sweep_confirmations: u32,
    /// Block height of sweep confirmation
    pub sweep_block_height: Option<u64>,
    /// Pool wallet address that received the sweep
    pub pool_address: Option<String>,
    /// Fee paid for the sweep transaction (in satoshis)
    pub sweep_fee_sats: Option<u64>,

    // Solana verification (uses sweep_txid)
    /// Solana transaction signature for SPV verification
    pub solana_tx: Option<String>,
    /// Leaf index in the commitment tree
    pub leaf_index: Option<u64>,

    // OP_RETURN stealth data (auto-detected from non-interactive deposits)
    /// Ephemeral public key from OP_RETURN (32 bytes hex)
    pub ephemeral_pub: Option<String>,
    /// Encrypted amount from OP_RETURN (8 bytes hex)
    /// @deprecated - npk-based deposits no longer use encrypted amounts in OP_RETURN
    pub encrypted_amount_hex: Option<String>,
    /// Note public key from OP_RETURN (32 bytes hex)
    pub npk: Option<String>,
    /// True if detected via OP_RETURN scanning (no prior API registration)
    pub auto_detected: bool,

    /// Timestamp when deposit was registered
    pub created_at: u64,
    /// Timestamp of last status update
    pub updated_at: u64,
    /// Error message if failed
    pub error: Option<String>,
    /// Number of retry attempts for failed operations
    pub retry_count: u32,
    /// Timestamp of last retry attempt
    pub last_retry_at: Option<u64>,
}

impl DepositRecord {
    /// Create a new deposit record
    pub fn new(taproot_address: String, commitment: String, amount_sats: u64) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let id = format!("dep_{}_{:08x}", now, rand::random::<u32>());

        Self {
            id,
            taproot_address,
            commitment,
            amount_sats,
            status: DepositStatus::Pending,
            confirmations: 0,
            deposit_txid: None,
            deposit_vout: None,
            deposit_block_height: None,
            sweep_txid: None,
            sweep_confirmations: 0,
            sweep_block_height: None,
            pool_address: None,
            sweep_fee_sats: None,
            solana_tx: None,
            leaf_index: None,
            ephemeral_pub: None,
            encrypted_amount_hex: None,
            npk: None,
            auto_detected: false,
            created_at: now,
            updated_at: now,
            error: None,
            retry_count: 0,
            last_retry_at: None,
        }
    }

    /// Update status and touch timestamp
    pub fn set_status(&mut self, status: DepositStatus) {
        self.status = status;
        self.touch();
    }

    /// Mark as detected (tx seen in mempool)
    pub fn mark_detected(&mut self, txid: String, vout: u32) {
        self.deposit_txid = Some(txid);
        self.deposit_vout = Some(vout);
        self.status = DepositStatus::Detected;
        self.touch();
    }

    /// Update confirmation count
    pub fn update_confirmations(&mut self, confirmations: u32, block_height: Option<u64>) {
        self.confirmations = confirmations;
        if let Some(height) = block_height {
            self.deposit_block_height = Some(height);
        }

        self.status = if confirmations == 0 {
            DepositStatus::Detected
        } else {
            DepositStatus::Confirmed
        };
        self.touch();
    }

    /// Mark as sweeping
    pub fn mark_sweeping(&mut self) {
        self.status = DepositStatus::Sweeping;
        self.touch();
    }

    /// Mark sweep tx broadcast
    pub fn mark_sweep_broadcast(&mut self, sweep_txid: String, pool_address: String, fee_sats: u64) {
        self.sweep_txid = Some(sweep_txid);
        self.pool_address = Some(pool_address);
        self.sweep_fee_sats = Some(fee_sats);
        self.status = DepositStatus::SweepConfirming;
        self.touch();
    }

    /// Update sweep confirmation count
    pub fn update_sweep_confirmations(&mut self, confirmations: u32, block_height: Option<u64>) {
        self.sweep_confirmations = confirmations;
        if let Some(height) = block_height {
            self.sweep_block_height = Some(height);
        }
        self.touch();
    }

    /// Mark as verifying (SPV proof being submitted)
    pub fn mark_verifying(&mut self) {
        self.status = DepositStatus::Verifying;
        self.touch();
    }

    /// Mark as ready (verified on Solana)
    pub fn mark_ready(&mut self, solana_tx: String, leaf_index: u64) {
        self.solana_tx = Some(solana_tx);
        self.leaf_index = Some(leaf_index);
        self.status = DepositStatus::Ready;
        self.touch();
    }

    /// Mark as claimed
    pub fn mark_claimed(&mut self) {
        self.status = DepositStatus::Claimed;
        self.touch();
    }

    /// Mark as failed
    pub fn mark_failed(&mut self, error: String) {
        self.error = Some(error);
        self.status = DepositStatus::Failed;
        self.touch();
    }

    /// Increment retry count and update last retry timestamp
    pub fn increment_retry(&mut self) {
        self.retry_count += 1;
        self.last_retry_at = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        );
    }

    /// Reset for retry - clear error and set status to resume from
    pub fn reset_for_retry(&mut self, resume_status: DepositStatus) {
        self.error = None;
        self.status = resume_status;
        self.increment_retry();
        self.touch();
    }

    /// Check if eligible for retry based on max retries
    pub fn can_retry(&self, max_retries: u32) -> bool {
        self.status == DepositStatus::Failed && self.retry_count < max_retries
    }

    /// Update timestamp
    fn touch(&mut self) {
        self.updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
    }

    /// Check if deposit can proceed to sweeping
    pub fn can_sweep(&self) -> bool {
        self.status == DepositStatus::Confirmed && self.confirmations >= 1
    }

    /// Check if sweep is ready for SPV verification
    pub fn can_verify(&self) -> bool {
        self.status == DepositStatus::SweepConfirming && self.sweep_confirmations >= 6
    }

    /// Check if user can claim zkBTC
    pub fn can_claim(&self) -> bool {
        self.status == DepositStatus::Ready
    }
}

// =============================================================================
// API Response Types
// =============================================================================

/// GET /api/deposits/:id - Deposit status response
#[derive(Debug, Serialize)]
pub struct DepositStatusResponse {
    pub id: String,
    pub status: String,
    pub taproot_address: String,
    pub amount_sats: u64,
    pub confirmations: u32,
    pub can_claim: bool,
    pub btc_txid: Option<String>,
    pub sweep_txid: Option<String>,
    pub sweep_confirmations: u32,
    pub solana_tx: Option<String>,
    pub leaf_index: Option<u64>,
    pub npk: Option<String>,
    pub ephemeral_pub: Option<String>,
    pub sweep_fee_sats: Option<u64>,
    pub minted_sats: Option<u64>,
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

impl From<&DepositRecord> for DepositStatusResponse {
    fn from(record: &DepositRecord) -> Self {
        let minted_sats = record.sweep_fee_sats.map(|fee| record.amount_sats.saturating_sub(fee));
        Self {
            id: record.id.clone(),
            status: record.status.to_string(),
            taproot_address: record.taproot_address.clone(),
            amount_sats: record.amount_sats,
            confirmations: record.confirmations,
            can_claim: record.can_claim(),
            btc_txid: record.deposit_txid.clone(),
            sweep_txid: record.sweep_txid.clone(),
            sweep_confirmations: record.sweep_confirmations,
            solana_tx: record.solana_tx.clone(),
            leaf_index: record.leaf_index,
            npk: record.npk.clone(),
            ephemeral_pub: record.ephemeral_pub.clone(),
            sweep_fee_sats: record.sweep_fee_sats,
            minted_sats,
            error: record.error.clone(),
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }
}

/// WebSocket message sent to clients
#[derive(Debug, Clone, Serialize)]
pub struct DepositStatusUpdate {
    pub deposit_id: String,
    pub status: String,
    pub confirmations: u32,
    pub sweep_confirmations: u32,
    pub can_claim: bool,
    pub error: Option<String>,
}

impl From<&DepositRecord> for DepositStatusUpdate {
    fn from(record: &DepositRecord) -> Self {
        Self {
            deposit_id: record.id.clone(),
            status: record.status.to_string(),
            confirmations: record.confirmations,
            sweep_confirmations: record.sweep_confirmations,
            can_claim: record.can_claim(),
            error: record.error.clone(),
        }
    }
}

/// Tracker service configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackerConfig {
    /// Polling interval in seconds
    pub poll_interval_secs: u64,
    /// Required confirmations for deposit
    pub required_confirmations: u32,
    /// Required confirmations for sweep before SPV
    pub required_sweep_confirmations: u32,
    /// Esplora API URL
    pub esplora_url: String,
    /// Solana RPC URL
    pub solana_rpc: String,
    /// Pool receive address for swept funds
    pub pool_receive_address: String,
    /// Path to SQLite database file
    pub db_path: String,
    /// Maximum retry attempts for failed operations
    pub max_retries: u32,
    /// Delay between retry attempts in seconds
    pub retry_delay_secs: u64,

    // ── WebSocket real-time listener ──
    /// Enable mempool.space WebSocket for real-time deposit detection + header relay
    pub ws_enabled: bool,
    /// mempool.space WebSocket URL
    pub ws_url: String,

    // ── Header relayer (integrated) ──
    /// Enable integrated block header relay via the same WS connection
    pub header_relay_enabled: bool,
    /// BTC light client program ID on Solana
    pub btc_light_client_program_id: String,
    /// Path to relayer Solana keypair (JSON array or file path)
    pub relayer_keypair: String,
    /// Minimum batch size for header submission (2-10)
    pub header_batch_size: u8,
}

impl Default for TrackerConfig {
    fn default() -> Self {
        Self {
            poll_interval_secs: 30,
            required_confirmations: 1, // Devnet: fast testing (use 3+ for production)
            required_sweep_confirmations: 6,
            esplora_url: String::new(),
            solana_rpc: "https://api.devnet.solana.com".to_string(),
            pool_receive_address: String::new(), // Must be set via env
            db_path: "data/deposits.db".to_string(),
            max_retries: 5,
            retry_delay_secs: 60,
            ws_enabled: true,
            ws_url: "wss://mempool.space/testnet4/api/v1/ws".to_string(),
            header_relay_enabled: false,
            btc_light_client_program_id: "Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq".to_string(),
            relayer_keypair: String::new(),
            header_batch_size: 5,
        }
    }
}

/// Tracker statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrackerStats {
    pub total_deposits: u64,
    pub pending: u64,
    pub confirming: u64,
    pub ready: u64,
    pub claimed: u64,
    pub failed: u64,
    pub total_sats_received: u64,
}

impl std::fmt::Display for TrackerStats {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Deposits: {} total | {} pending | {} confirming | {} ready | {} claimed | {} failed",
            self.total_deposits,
            self.pending,
            self.confirming,
            self.ready,
            self.claimed,
            self.failed
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deposit_record_lifecycle() {
        let mut record = DepositRecord::new(
            "tb1p123...".to_string(),
            "abcd".repeat(16),
            100_000,
        );

        assert_eq!(record.status, DepositStatus::Pending);
        assert!(!record.can_claim());
        assert_eq!(record.retry_count, 0);
        assert!(record.last_retry_at.is_none());

        // Detect
        record.mark_detected("txid123".to_string(), 0);
        assert_eq!(record.status, DepositStatus::Detected);

        // Confirm (1 confirmation is enough for demo/testing)
        record.update_confirmations(1, Some(1000));
        assert_eq!(record.status, DepositStatus::Confirmed);
        assert!(record.can_sweep());

        // Sweep
        record.mark_sweeping();
        record.mark_sweep_broadcast("sweep_txid".to_string(), "pool_addr".to_string(), 222);
        assert_eq!(record.status, DepositStatus::SweepConfirming);

        // Sweep confirms (6 required)
        record.update_sweep_confirmations(6, Some(1006));
        assert!(record.can_verify());

        // Verify
        record.mark_verifying();
        record.mark_ready("sol_tx".to_string(), 42);
        assert_eq!(record.status, DepositStatus::Ready);
        assert!(record.can_claim());
    }

    #[test]
    fn test_retry_logic() {
        let mut record = DepositRecord::new(
            "tb1p123...".to_string(),
            "abcd".repeat(16),
            100_000,
        );

        // Mark as failed
        record.mark_failed("test error".to_string());
        assert_eq!(record.status, DepositStatus::Failed);
        assert!(record.can_retry(5));
        assert!(!record.can_retry(0));

        // Reset for retry
        record.reset_for_retry(DepositStatus::Confirmed);
        assert_eq!(record.status, DepositStatus::Confirmed);
        assert_eq!(record.retry_count, 1);
        assert!(record.last_retry_at.is_some());
        assert!(record.error.is_none());

        // After max retries
        record.retry_count = 5;
        record.mark_failed("another error".to_string());
        assert!(!record.can_retry(5));
    }

    #[test]
    fn test_status_display() {
        assert_eq!(DepositStatus::Pending.to_string(), "pending");
        assert_eq!(DepositStatus::Confirming.to_string(), "confirming");
        assert_eq!(DepositStatus::Ready.to_string(), "ready");
    }
}
