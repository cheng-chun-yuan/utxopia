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
    /// BTC confirmed, ready to announce
    Confirmed,
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
            Self::Announcing => write!(f, "announcing"),
            Self::Announced => write!(f, "announced"),
            Self::Expired => write!(f, "expired"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

/// A stealth deposit record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StealthDepositRecord {
    /// Unique deposit ID
    pub id: String,

    /// Stealth deposit mode
    pub mode: StealthMode,

    /// Recipient's stealth meta-address (130 hex chars = 65 bytes)
    /// Format: spending_pubkey (33 bytes) || viewing_pubkey (32 bytes)
    pub recipient_stealth_address: String,

    /// Amount in satoshis (required for commitment computation)
    pub amount_sats: u64,

    /// Taproot deposit address (derived from commitment)
    pub taproot_address: String,

    /// Current status
    pub status: StealthDepositStatus,

    /// Number of confirmations
    pub confirmations: u32,

    // Ephemeral keys (stored for relay mode, cleared after announcement)
    /// Ephemeral X25519 viewing private key (32 bytes, hex)
    /// Only stored for relay mode
    pub ephemeral_view_priv: Option<String>,

    /// Ephemeral X25519 viewing public key (32 bytes, hex)
    pub ephemeral_view_pub: String,

    /// Ephemeral Grumpkin spending private key (32 bytes, hex)
    /// Only stored for relay mode
    pub ephemeral_spend_priv: Option<String>,

    /// Ephemeral Grumpkin spending public key (33 bytes compressed, hex)
    pub ephemeral_spend_pub: String,

    /// Commitment (32 bytes, hex)
    pub commitment: String,

    // Bitcoin transaction info
    /// Bitcoin transaction ID
    pub btc_txid: Option<String>,

    /// Block height of confirmation
    pub block_height: Option<u64>,

    // Solana announcement info
    /// Solana transaction signature
    pub solana_tx: Option<String>,

    /// Leaf index in commitment tree
    pub leaf_index: Option<u64>,

    // Timestamps
    /// Creation timestamp
    pub created_at: u64,

    /// Last update timestamp
    pub updated_at: u64,

    /// Expiration timestamp (24h after creation)
    pub expires_at: u64,

    /// Error message if failed
    pub error: Option<String>,
}

impl StealthDepositRecord {
    /// Create a new stealth deposit record
    pub fn new(
        mode: StealthMode,
        recipient_stealth_address: String,
        amount_sats: u64,
        taproot_address: String,
        ephemeral_view_priv: Option<String>,
        ephemeral_view_pub: String,
        ephemeral_spend_priv: Option<String>,
        ephemeral_spend_pub: String,
        commitment: String,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let id = format!("stealth_{}_{:08x}", now, rand::random::<u32>());
        let expires_at = now + 24 * 60 * 60; // 24 hours

        Self {
            id,
            mode,
            recipient_stealth_address,
            amount_sats,
            taproot_address,
            status: StealthDepositStatus::Pending,
            confirmations: 0,
            ephemeral_view_priv,
            ephemeral_view_pub,
            ephemeral_spend_priv,
            ephemeral_spend_pub,
            commitment,
            btc_txid: None,
            block_height: None,
            solana_tx: None,
            leaf_index: None,
            created_at: now,
            updated_at: now,
            expires_at,
            error: None,
        }
    }

    /// Check if deposit has expired
    pub fn is_expired(&self) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        now > self.expires_at && self.status == StealthDepositStatus::Pending
    }

    /// Update status
    pub fn set_status(&mut self, status: StealthDepositStatus) {
        self.status = status;
        self.touch();
    }

    /// Mark as detected
    pub fn mark_detected(&mut self, txid: String) {
        self.btc_txid = Some(txid);
        self.status = StealthDepositStatus::Detected;
        self.touch();
    }

    /// Update confirmations
    pub fn update_confirmations(&mut self, confirmations: u32, block_height: Option<u64>) {
        self.confirmations = confirmations;
        if let Some(height) = block_height {
            self.block_height = Some(height);
        }

        if confirmations == 0 {
            self.status = StealthDepositStatus::Detected;
        } else if confirmations < 1 {
            self.status = StealthDepositStatus::Confirming;
        } else {
            self.status = StealthDepositStatus::Confirmed;
        }
        self.touch();
    }

    /// Mark as announcing
    pub fn mark_announcing(&mut self) {
        self.status = StealthDepositStatus::Announcing;
        self.touch();
    }

    /// Mark as announced
    pub fn mark_announced(&mut self, solana_tx: String, leaf_index: u64) {
        self.solana_tx = Some(solana_tx);
        self.leaf_index = Some(leaf_index);
        self.status = StealthDepositStatus::Announced;
        // Clear private keys after announcement
        self.ephemeral_view_priv = None;
        self.ephemeral_spend_priv = None;
        self.touch();
    }

    /// Mark as expired
    pub fn mark_expired(&mut self) {
        self.status = StealthDepositStatus::Expired;
        // Clear private keys
        self.ephemeral_view_priv = None;
        self.ephemeral_spend_priv = None;
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

    /// Check if ready for announcement (relay mode)
    pub fn can_announce(&self) -> bool {
        self.mode == StealthMode::Relay
            && self.status == StealthDepositStatus::Confirmed
            && self.confirmations >= 1
            && self.ephemeral_view_priv.is_some()
    }
}

// =============================================================================
// API Request/Response Types
// =============================================================================

/// POST /api/stealth/prepare - Prepare a stealth deposit
#[derive(Debug, Deserialize)]
pub struct PrepareStealthRequest {
    /// Recipient's stealth meta-address (130 hex chars)
    pub recipient_stealth_address: String,
    /// Amount in satoshis
    pub amount_sats: u64,
    /// Deposit mode
    #[serde(default)]
    pub mode: StealthMode,
}

/// Response to POST /api/stealth/prepare (relay mode)
#[derive(Debug, Serialize)]
pub struct PrepareStealthRelayResponse {
    pub success: bool,
    /// Deposit ID for tracking (relay mode only)
    pub deposit_id: Option<String>,
    /// Taproot address to send BTC to
    pub taproot_address: Option<String>,
    /// Amount to send (must be exact)
    pub amount_sats: u64,
    /// Expiration timestamp
    pub expires_at: Option<u64>,
    /// Error message
    pub message: Option<String>,
}

/// Response to POST /api/stealth/prepare (self-custody mode)
#[derive(Debug, Serialize)]
pub struct PrepareStealthSelfCustodyResponse {
    pub success: bool,
    /// Taproot address to send BTC to
    pub taproot_address: Option<String>,
    /// Amount to send (must be exact)
    pub amount_sats: u64,
    /// Encoded stealth data for manual announcement
    /// Format: zvault:1:{base64}
    pub stealth_data: Option<String>,
    /// Error message
    pub message: Option<String>,
}

/// GET /api/stealth/status/:id - Stealth deposit status
#[derive(Debug, Serialize)]
pub struct StealthStatusResponse {
    pub id: String,
    pub status: String,
    pub confirmations: u32,
    pub btc_txid: Option<String>,
    pub solana_tx: Option<String>,
    pub leaf_index: Option<u64>,
    pub expires_at: u64,
    pub error: Option<String>,
}

impl From<&StealthDepositRecord> for StealthStatusResponse {
    fn from(record: &StealthDepositRecord) -> Self {
        Self {
            id: record.id.clone(),
            status: record.status.to_string(),
            confirmations: record.confirmations,
            btc_txid: record.btc_txid.clone(),
            solana_tx: record.solana_tx.clone(),
            leaf_index: record.leaf_index,
            expires_at: record.expires_at,
            error: record.error.clone(),
        }
    }
}

/// POST /api/stealth/announce - Manual announcement (self-custody mode)
#[derive(Debug, Deserialize)]
pub struct ManualAnnounceRequest {
    /// Encoded stealth data from prepare response
    pub stealth_data: String,
    /// Bitcoin transaction ID
    pub btc_txid: String,
}

/// Response to POST /api/stealth/announce
#[derive(Debug, Serialize)]
pub struct ManualAnnounceResponse {
    pub success: bool,
    pub solana_tx: Option<String>,
    pub leaf_index: Option<u64>,
    pub message: Option<String>,
}

// =============================================================================
// Stealth Data Encoding
// =============================================================================

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
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, json);
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
            StealthMode::Relay,
            "d".repeat(130),
            100_000,
            "tb1p123...".to_string(),
            Some("priv_view".to_string()),
            "pub_view".to_string(),
            Some("priv_spend".to_string()),
            "pub_spend".to_string(),
            "c".repeat(64),
        );

        assert_eq!(record.status, StealthDepositStatus::Pending);
        assert!(!record.is_expired());

        record.mark_detected("txid123".to_string());
        assert_eq!(record.status, StealthDepositStatus::Detected);

        record.update_confirmations(1, Some(1000));
        assert_eq!(record.status, StealthDepositStatus::Confirmed);
        assert!(record.can_announce());

        record.mark_announced("sol_tx".to_string(), 42);
        assert_eq!(record.status, StealthDepositStatus::Announced);
        assert!(record.ephemeral_view_priv.is_none()); // Keys cleared
    }
}
