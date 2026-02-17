//! Stealth Deposit Types
//!
//! Types for stealth deposits that allow sending BTC to someone's stealth address.
//! Two modes are supported:
//! - Relay mode: Backend stores ephemeral keys and auto-announces after deposit
//! - Self-custody mode: User saves stealth data and announces manually
//!
//! Lifecycle:
//! PENDING → DETECTED → CONFIRMING → CONFIRMED → ANNOUNCING → ANNOUNCED

use serde::{Deserialize, Serialize};

/// Stealth deposit mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StealthMode {
    /// Backend stores ephemeral keys and auto-announces
    Relay,
    /// User saves stealth data and announces manually
    SelfCustody,
}

impl Default for StealthMode {
    fn default() -> Self {
        Self::Relay
    }
}

/// Status of a stealth deposit
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StealthDepositStatus {
    /// Waiting for BTC deposit
    Pending,
    /// BTC transaction detected in mempool
    Detected,
    /// Waiting for confirmations
    Confirming,
    /// BTC confirmed, ready to sweep/announce
    Confirmed,
    /// Creating and broadcasting sweep tx to pool wallet
    Sweeping,
    /// Waiting for sweep confirmations
    SweepConfirming,
    /// Submitting on-chain verification
    Verifying,
    /// Verified on Solana, user can claim
    Ready,
    /// Posting announcement to Solana
    Announcing,
    /// Announcement posted, recipient can scan
    Announced,
    /// Expired (no deposit within 24h)
    Expired,
    /// Error occurred
    Failed,
}

impl Default for StealthDepositStatus {
    fn default() -> Self {
        Self::Pending
    }
}

impl std::fmt::Display for StealthDepositStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Detected => write!(f, "detected"),
            Self::Confirming => write!(f, "confirming"),
            Self::Confirmed => write!(f, "confirmed"),
            Self::Sweeping => write!(f, "sweeping"),
            Self::SweepConfirming => write!(f, "sweep_confirming"),
            Self::Verifying => write!(f, "verifying"),
            Self::Ready => write!(f, "ready"),
            Self::Announcing => write!(f, "announcing"),
            Self::Announced => write!(f, "announced"),
            Self::Expired => write!(f, "expired"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

/// A stealth deposit record (for backend-managed V2 flow)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StealthDepositRecord {
    /// Unique deposit ID
    pub id: String,

    // User's stealth keys (public)
    /// User's viewing public key (33 bytes Grumpkin compressed, hex)
    pub viewing_pub: String,
    /// User's spending public key (33 bytes Grumpkin compressed, hex)
    pub spending_pub: String,

    // Backend-generated ephemeral key (private key encrypted/stored securely)
    /// Ephemeral public key for ECDH (33 bytes Grumpkin compressed, hex)
    pub ephemeral_pub: String,
    /// Encrypted ephemeral private key (for signing)
    pub ephemeral_priv_encrypted: String,

    /// Pre-computed commitment = Poseidon2(stealthPub.x, placeholder_amount)
    /// Recomputed with actual amount after deposit detected
    pub commitment: String,

    /// Bitcoin taproot deposit address (tb1p... for testnet)
    pub btc_address: String,

    /// Current status
    pub status: StealthDepositStatus,

    // Deposit info (filled after detection)
    /// Actual amount received in satoshis
    pub actual_amount_sats: Option<u64>,
    /// Number of confirmations on deposit tx
    pub confirmations: u32,
    /// Deposit transaction ID
    pub deposit_txid: Option<String>,
    /// Deposit vout
    pub deposit_vout: Option<u32>,
    /// Block height of deposit
    pub deposit_block_height: Option<u64>,

    // Sweep info
    /// Sweep transaction ID
    pub sweep_txid: Option<String>,
    /// Sweep confirmations
    pub sweep_confirmations: u32,
    /// Block height of sweep
    pub sweep_block_height: Option<u64>,

    // Solana verification
    /// Solana transaction signature
    pub solana_tx: Option<String>,
    /// Leaf index in commitment tree
    pub leaf_index: Option<u64>,

    // Timestamps
    pub created_at: u64,
    pub updated_at: u64,
    pub expires_at: u64,

    /// Error message if failed
    pub error: Option<String>,
}

impl StealthDepositRecord {
    /// Create a new stealth deposit record
    pub fn new(
        viewing_pub: String,
        spending_pub: String,
        ephemeral_pub: String,
        ephemeral_priv_encrypted: String,
        commitment: String,
        btc_address: String,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let id = format!("sdep_{}_{:08x}", now, rand::random::<u32>());

        Self {
            id,
            viewing_pub,
            spending_pub,
            ephemeral_pub,
            ephemeral_priv_encrypted,
            commitment,
            btc_address,
            status: StealthDepositStatus::Pending,
            actual_amount_sats: None,
            confirmations: 0,
            deposit_txid: None,
            deposit_vout: None,
            deposit_block_height: None,
            sweep_txid: None,
            sweep_confirmations: 0,
            sweep_block_height: None,
            solana_tx: None,
            leaf_index: None,
            created_at: now,
            updated_at: now,
            expires_at: now + 86400, // 24 hours
            error: None,
        }
    }

    /// Update status and touch timestamp
    pub fn set_status(&mut self, status: StealthDepositStatus) {
        self.status = status;
        self.touch();
    }

    /// Mark as detected
    pub fn mark_detected(&mut self, txid: String, vout: u32, amount_sats: u64) {
        self.deposit_txid = Some(txid);
        self.deposit_vout = Some(vout);
        self.actual_amount_sats = Some(amount_sats);
        self.status = StealthDepositStatus::Detected;
        self.touch();
    }

    /// Update confirmation count
    pub fn update_confirmations(&mut self, confirmations: u32, block_height: Option<u64>) {
        self.confirmations = confirmations;
        if let Some(height) = block_height {
            self.deposit_block_height = Some(height);
        }

        self.status = if confirmations == 0 {
            StealthDepositStatus::Detected
        } else {
            StealthDepositStatus::Confirmed
        };
        self.touch();
    }

    /// Mark as sweeping
    pub fn mark_sweeping(&mut self) {
        self.status = StealthDepositStatus::Sweeping;
        self.touch();
    }

    /// Mark sweep broadcast
    pub fn mark_sweep_broadcast(&mut self, sweep_txid: String) {
        self.sweep_txid = Some(sweep_txid);
        self.status = StealthDepositStatus::SweepConfirming;
        self.touch();
    }

    /// Update sweep confirmations
    pub fn update_sweep_confirmations(&mut self, confirmations: u32, block_height: Option<u64>) {
        self.sweep_confirmations = confirmations;
        if let Some(height) = block_height {
            self.sweep_block_height = Some(height);
        }
        self.touch();
    }

    /// Mark as verifying
    pub fn mark_verifying(&mut self) {
        self.status = StealthDepositStatus::Verifying;
        self.touch();
    }

    /// Mark as ready
    pub fn mark_ready(&mut self, solana_tx: String, leaf_index: u64) {
        self.solana_tx = Some(solana_tx);
        self.leaf_index = Some(leaf_index);
        self.status = StealthDepositStatus::Ready;
        self.touch();
    }

    /// Mark as failed
    pub fn mark_failed(&mut self, error: String) {
        self.error = Some(error);
        self.status = StealthDepositStatus::Failed;
        self.touch();
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
        self.status == StealthDepositStatus::Confirmed && self.confirmations >= 1
    }

    /// Check if sweep is ready for SPV verification
    pub fn can_verify(&self) -> bool {
        self.status == StealthDepositStatus::SweepConfirming && self.sweep_confirmations >= 1
    }

    /// Check if deposit is ready for user to claim
    pub fn is_ready(&self) -> bool {
        self.status == StealthDepositStatus::Ready
    }
}

// =============================================================================
// API Request/Response Types
// =============================================================================

/// POST /api/v2/prepare-deposit - Prepare a stealth deposit
#[derive(Debug, Deserialize)]
pub struct PrepareStealthDepositRequest {
    /// User's viewing public key (66 hex chars = 33 bytes Grumpkin compressed)
    pub viewing_pub: String,
    /// User's spending public key (66 hex chars = 33 bytes Grumpkin compressed)
    pub spending_pub: String,
}

/// Response to POST /api/v2/prepare-deposit
#[derive(Debug, Serialize)]
pub struct PrepareStealthDepositResponse {
    pub success: bool,
    pub deposit_id: Option<String>,
    pub btc_address: Option<String>,
    pub ephemeral_pub: Option<String>,
    pub expires_at: Option<u64>,
    pub error: Option<String>,
}

/// GET /api/v2/deposits/:id - Stealth deposit status
#[derive(Debug, Serialize)]
pub struct StealthDepositStatusResponse {
    pub id: String,
    pub status: String,
    pub btc_address: String,
    pub ephemeral_pub: String,
    pub actual_amount_sats: Option<u64>,
    pub confirmations: u32,
    pub sweep_confirmations: u32,
    pub deposit_txid: Option<String>,
    pub sweep_txid: Option<String>,
    pub solana_tx: Option<String>,
    pub leaf_index: Option<u64>,
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub expires_at: u64,
}

impl From<&StealthDepositRecord> for StealthDepositStatusResponse {
    fn from(record: &StealthDepositRecord) -> Self {
        Self {
            id: record.id.clone(),
            status: record.status.to_string(),
            btc_address: record.btc_address.clone(),
            ephemeral_pub: record.ephemeral_pub.clone(),
            actual_amount_sats: record.actual_amount_sats,
            confirmations: record.confirmations,
            sweep_confirmations: record.sweep_confirmations,
            deposit_txid: record.deposit_txid.clone(),
            sweep_txid: record.sweep_txid.clone(),
            solana_tx: record.solana_tx.clone(),
            leaf_index: record.leaf_index,
            error: record.error.clone(),
            created_at: record.created_at,
            updated_at: record.updated_at,
            expires_at: record.expires_at,
        }
    }
}

/// WebSocket message for stealth deposit updates
#[derive(Debug, Clone, Serialize)]
pub struct StealthDepositStatusUpdate {
    pub deposit_id: String,
    pub status: String,
    pub actual_amount_sats: Option<u64>,
    pub confirmations: u32,
    pub sweep_confirmations: u32,
    pub is_ready: bool,
    pub error: Option<String>,
}

impl From<&StealthDepositRecord> for StealthDepositStatusUpdate {
    fn from(record: &StealthDepositRecord) -> Self {
        Self {
            deposit_id: record.id.clone(),
            status: record.status.to_string(),
            actual_amount_sats: record.actual_amount_sats,
            confirmations: record.confirmations,
            sweep_confirmations: record.sweep_confirmations,
            is_ready: record.is_ready(),
            error: record.error.clone(),
        }
    }
}

/// Encoded stealth data for self-custody mode
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StealthData {
    /// Version (1)
    pub version: u8,
    /// Ephemeral X25519 viewing public key (32 bytes, hex)
    pub ephemeral_view_pub: String,
    /// Ephemeral Grumpkin spending public key (33 bytes, hex)
    pub ephemeral_spend_pub: String,
    /// Commitment (32 bytes, hex)
    pub commitment: String,
    /// Amount in satoshis
    pub amount_sats: u64,
    /// Recipient's stealth address (for verification)
    pub recipient_stealth_address: String,
}

impl StealthData {
    /// Encode to string format: zvault:1:{base64_json}
    pub fn encode(&self) -> String {
        let json = serde_json::to_string(self).unwrap();
        let b64 =
            base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, json);
        format!("zvault:{}:{}", self.version, b64)
    }

    /// Decode from string format
    pub fn decode(encoded: &str) -> Result<Self, String> {
        let parts: Vec<&str> = encoded.split(':').collect();
        if parts.len() != 3 || parts[0] != "zvault" {
            return Err("Invalid stealth data format".to_string());
        }

        let version: u8 = parts[1].parse().map_err(|_| "Invalid version")?;
        if version != 1 {
            return Err(format!("Unsupported version: {}", version));
        }

        let json =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, parts[2])
                .map_err(|e| format!("Base64 decode error: {}", e))?;

        let data: StealthData =
            serde_json::from_slice(&json).map_err(|e| format!("JSON decode error: {}", e))?;

        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stealth_data_encode_decode() {
        let data = StealthData {
            version: 1,
            ephemeral_view_pub: "a".repeat(64),
            ephemeral_spend_pub: "b".repeat(66),
            commitment: "c".repeat(64),
            amount_sats: 100_000,
            recipient_stealth_address: "d".repeat(130),
        };

        let encoded = data.encode();
        assert!(encoded.starts_with("zvault:1:"));

        let decoded = StealthData::decode(&encoded).unwrap();
        assert_eq!(decoded.ephemeral_view_pub, data.ephemeral_view_pub);
        assert_eq!(decoded.amount_sats, data.amount_sats);
    }

    #[test]
    fn test_stealth_deposit_lifecycle() {
        let mut record = StealthDepositRecord::new(
            "viewing_pub".to_string(),
            "spending_pub".to_string(),
            "ephemeral_pub".to_string(),
            "ephemeral_priv".to_string(),
            "c".repeat(64),
            "tb1p123...".to_string(),
        );

        assert_eq!(record.status, StealthDepositStatus::Pending);

        record.mark_detected("txid123".to_string(), 0, 100000);
        assert_eq!(record.status, StealthDepositStatus::Detected);
        assert_eq!(record.actual_amount_sats, Some(100000));

        record.update_confirmations(1, Some(1000));
        assert_eq!(record.status, StealthDepositStatus::Confirmed);
        assert!(record.can_sweep());

        record.mark_ready("sol_tx".to_string(), 42);
        assert_eq!(record.status, StealthDepositStatus::Ready);
        assert!(record.is_ready());
    }
}
