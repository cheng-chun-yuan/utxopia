//! Redemption Types
//!
//! Types for the redemption/withdrawal service.

use serde::{Deserialize, Serialize};

/// Status of a withdrawal request
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WithdrawalStatus {
    /// Request received, pending processing
    Pending,
    /// Building BTC transaction
    Building,
    /// Signing transaction (single-key or MPC)
    Signing,
    /// Broadcasting to Bitcoin network
    Broadcasting,
    /// Waiting for BTC confirmations
    Confirming,
    /// Complete - BTC sent
    Complete,
    /// Failed
    Failed,
}

impl Default for WithdrawalStatus {
    fn default() -> Self {
        Self::Pending
    }
}

impl std::fmt::Display for WithdrawalStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Building => write!(f, "building"),
            Self::Signing => write!(f, "signing"),
            Self::Broadcasting => write!(f, "broadcasting"),
            Self::Confirming => write!(f, "confirming"),
            Self::Complete => write!(f, "complete"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

/// A withdrawal/redemption request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WithdrawalRequest {
    /// Unique request ID
    pub id: String,
    /// Solana transaction that burned zkBTC
    pub solana_burn_tx: String,
    /// User's Solana address
    pub user_solana_address: String,
    /// Amount in satoshis
    pub amount_sats: u64,
    /// Destination Bitcoin address
    pub btc_address: String,
    /// Network fee in satoshis
    pub fee_sats: u64,
    /// Current status
    pub status: WithdrawalStatus,
    /// BTC transaction ID (when broadcast)
    pub btc_txid: Option<String>,
    /// BTC confirmations
    pub btc_confirmations: u32,
    /// Timestamp when request was created
    pub created_at: u64,
    /// Timestamp of last update
    pub updated_at: u64,
    /// Error message if failed
    pub error: Option<String>,
    /// On-chain redemption nonce (from RedemptionRequest PDA) for FROST Solana verification
    #[serde(default)]
    pub redemption_nonce: Option<u64>,
}

impl WithdrawalRequest {
    /// Create a new withdrawal request
    pub fn new(
        solana_burn_tx: String,
        user_solana_address: String,
        amount_sats: u64,
        btc_address: String,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Generate unique ID
        let id = format!(
            "wd_{}_{:x}",
            now,
            rand::random::<u32>()
        );

        Self {
            id,
            solana_burn_tx,
            user_solana_address,
            amount_sats,
            btc_address,
            fee_sats: 1000, // Default fee, will be calculated
            status: WithdrawalStatus::Pending,
            btc_txid: None,
            btc_confirmations: 0,
            created_at: now,
            updated_at: now,
            error: None,
            redemption_nonce: None,
        }
    }

    /// Calculate net amount after fees
    pub fn net_amount(&self) -> u64 {
        self.amount_sats.saturating_sub(self.fee_sats)
    }

    /// Update status
    pub fn set_status(&mut self, status: WithdrawalStatus) {
        self.status = status;
        self.touch();
    }

    /// Mark as building
    pub fn mark_building(&mut self) {
        self.status = WithdrawalStatus::Building;
        self.touch();
    }

    /// Mark as signing
    pub fn mark_signing(&mut self) {
        self.status = WithdrawalStatus::Signing;
        self.touch();
    }

    /// Mark as broadcasting
    pub fn mark_broadcasting(&mut self) {
        self.status = WithdrawalStatus::Broadcasting;
        self.touch();
    }

    /// Mark as confirming with txid
    pub fn mark_confirming(&mut self, btc_txid: String) {
        self.btc_txid = Some(btc_txid);
        self.status = WithdrawalStatus::Confirming;
        self.touch();
    }

    /// Mark as complete
    pub fn mark_complete(&mut self, confirmations: u32) {
        self.btc_confirmations = confirmations;
        self.status = WithdrawalStatus::Complete;
        self.touch();
    }

    /// Mark as failed
    pub fn mark_failed(&mut self, error: String) {
        self.error = Some(error);
        self.status = WithdrawalStatus::Failed;
        self.touch();
    }

    fn touch(&mut self) {
        self.updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
    }
}

/// Burn event detected on Solana
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BurnEvent {
    /// Solana transaction signature
    pub signature: String,
    /// User who burned tokens
    pub user: String,
    /// Amount burned (in satoshi-equivalent)
    pub amount: u64,
    /// Destination BTC address
    pub btc_address: String,
    /// Block slot
    pub slot: u64,
    /// Timestamp
    pub timestamp: u64,
}

/// Redemption service configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedemptionConfig {
    /// Minimum withdrawal amount (sats)
    pub min_withdrawal: u64,
    /// Maximum withdrawal amount (sats)
    pub max_withdrawal: u64,
    /// Default fee rate (sats/vbyte)
    pub fee_rate: u64,
    /// Required BTC confirmations for completion
    pub required_confirmations: u32,
    /// Check interval in seconds
    pub check_interval_secs: u64,
    /// Solana RPC URL
    pub solana_rpc: String,
    /// Esplora API URL
    pub esplora_url: String,
    /// Enable auto-processing
    pub auto_process: bool,
    /// Pool BTC address (for fetching UTXOs from Esplora)
    pub pool_address: String,
    /// Flat service fee per withdrawal (sats) — deducted from amount before sending BTC
    pub service_fee_sats: u64,
}

impl Default for RedemptionConfig {
    fn default() -> Self {
        Self {
            min_withdrawal: 10_000,        // 0.0001 BTC
            max_withdrawal: 10_000_000_000, // 100 BTC
            fee_rate: 10,                   // 10 sats/vbyte
            required_confirmations: 1,      // For testnet, 1 is enough
            check_interval_secs: 30,
            solana_rpc: "https://api.devnet.solana.com".to_string(),
            esplora_url: String::new(),
            auto_process: true,
            pool_address: std::env::var("POOL_RECEIVE_ADDRESS").unwrap_or_default(),
            service_fee_sats: std::env::var("SERVICE_FEE_SATS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(500),
        }
    }
}

/// Redemption service statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RedemptionStats {
    pub total_requests: u64,
    pub pending: u64,
    pub processing: u64,
    pub complete: u64,
    pub failed: u64,
    pub total_sats_withdrawn: u64,
    pub total_fees_paid: u64,
}

impl std::fmt::Display for RedemptionStats {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Withdrawals: {} total | {} pending | {} processing | {} complete | {} failed",
            self.total_requests,
            self.pending,
            self.processing,
            self.complete,
            self.failed
        )
    }
}

/// UTXO for pool spending
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolUtxo {
    /// Transaction ID
    pub txid: String,
    /// Output index
    pub vout: u32,
    /// Amount in satoshis
    pub amount_sats: u64,
    /// Script pubkey (hex)
    pub script_pubkey: String,
}

impl PoolUtxo {
    pub fn outpoint(&self) -> String {
        format!("{}:{}", self.txid, self.vout)
    }
}

/// Parsed on-chain RedemptionRequest PDA
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedRedemption {
    /// PDA address (base58)
    pub pda_address: String,
    /// On-chain status: 0=Pending, 1=Processing, 2=Failed
    pub status: u8,
    /// Requester's Solana pubkey (base58)
    pub requester: String,
    /// Withdrawal amount in satoshis
    pub amount_sats: u64,
    /// Raw scriptPubKey bytes for the BTC destination
    pub btc_script: Vec<u8>,
    /// On-chain request nonce
    pub request_id: u64,
    /// Slot when processing started
    pub processing_slot: u32,
}

/// Local tracking state for in-flight redemptions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedemptionTracking {
    /// PDA address being tracked
    pub pda_address: String,
    /// BTC transaction ID once broadcast
    pub btc_txid: Option<String>,
    /// Backend-side status
    pub local_status: LocalRedemptionStatus,
    /// Number of retry attempts
    pub retry_count: u32,
    /// Unix timestamp when first detected
    pub created_at: u64,
    /// Unix timestamp of last status change
    pub last_updated: u64,
    /// Error message if failed
    pub error: Option<String>,
    /// Verified transaction PDA address (set after verify_transaction succeeds)
    #[serde(default)]
    pub verified_tx_pda: Option<String>,
    /// ChadBuffer address (set during SPV upload, cleared after close)
    #[serde(default)]
    pub buffer_pubkey: Option<String>,
    /// Stripped raw tx size (needed for complete_redemption instruction)
    #[serde(default)]
    pub tx_size: Option<u32>,
}

/// Backend-side redemption status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LocalRedemptionStatus {
    /// PDA detected on-chain
    Detected,
    /// FROST signing in progress
    Signing,
    /// BTC transaction broadcast, waiting for confirmations
    AwaitingConfirmation,
    /// SPV verification complete (verify_transaction succeeded), awaiting complete_redemption call
    SpvVerified,
    /// Fully confirmed and complete_redemption called
    Completed,
    /// Terminal failure
    Failed,
}
