//! Minimal Esplora API Client for Redemption Service
//!
//! This is a simplified version of the Esplora client used only by the
//! redemption processor for checking transaction confirmations and broadcasting.

use reqwest::Client;
use serde::Deserialize;

/// Esplora API endpoints
pub const MAINNET_URL: &str = "https://blockstream.info/api";
pub const TESTNET_URL: &str = "https://blockstream.info/testnet/api";

/// Esplora HTTP client
#[derive(Debug, Clone)]
pub struct EsploraClient {
    client: Client,
    base_url: String,
}

impl EsploraClient {
    /// Create a new client with custom URL
    pub fn new(base_url: &str) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// Create a client for Bitcoin mainnet
    pub fn new_mainnet() -> Self {
        Self::new(MAINNET_URL)
    }

    /// Create a client for Bitcoin testnet
    pub fn new_testnet() -> Self {
        Self::new(TESTNET_URL)
    }

    /// Get the base URL
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Get transaction status
    pub async fn get_tx_status(&self, txid: &str) -> Result<EsploraTxStatus, EsploraError> {
        let url = format!("{}/tx/{}/status", self.base_url, txid);
        let resp = self.client.get(&url).send().await?;

        if !resp.status().is_success() {
            return Err(EsploraError::TxNotFound(txid.to_string()));
        }

        let status: EsploraTxStatus = resp.json().await?;
        Ok(status)
    }

    /// Get current block height
    pub async fn get_block_height(&self) -> Result<u64, EsploraError> {
        let url = format!("{}/blocks/tip/height", self.base_url);
        let resp = self.client.get(&url).send().await?;

        let height: u64 = resp
            .text()
            .await?
            .parse()
            .map_err(|_| EsploraError::ParseError("Failed to parse block height".to_string()))?;

        Ok(height)
    }

    /// Calculate confirmations for a transaction
    pub async fn get_confirmations(&self, txid: &str) -> Result<u32, EsploraError> {
        let status = self.get_tx_status(txid).await?;

        if !status.confirmed {
            return Ok(0);
        }

        let current_height = self.get_block_height().await?;
        let tx_height = status.block_height.unwrap_or(current_height);

        let confirmations = current_height.saturating_sub(tx_height) + 1;
        Ok(confirmations as u32)
    }

    /// Broadcast a raw transaction
    pub async fn broadcast_tx(&self, tx_hex: &str) -> Result<String, EsploraError> {
        let url = format!("{}/tx", self.base_url);
        let resp = self.client.post(&url).body(tx_hex.to_string()).send().await?;

        if !resp.status().is_success() {
            let error_text = resp.text().await.unwrap_or_default();
            return Err(EsploraError::BroadcastFailed(error_text));
        }

        let txid = resp.text().await?;
        Ok(txid)
    }
}

/// Transaction status
#[derive(Debug, Clone, Deserialize)]
pub struct EsploraTxStatus {
    pub confirmed: bool,
    pub block_height: Option<u64>,
    pub block_hash: Option<String>,
    pub block_time: Option<u64>,
}

/// Esplora error types
#[derive(Debug, thiserror::Error)]
pub enum EsploraError {
    #[error("HTTP request failed: {0}")]
    HttpError(#[from] reqwest::Error),

    #[error("Transaction not found: {0}")]
    TxNotFound(String),

    #[error("Parse error: {0}")]
    ParseError(String),

    #[error("Broadcast failed: {0}")]
    BroadcastFailed(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_get_block_height() {
        let client = EsploraClient::new_testnet();
        let height = client.get_block_height().await;
        assert!(height.is_ok());
        assert!(height.unwrap() > 0);
    }

    #[tokio::test]
    async fn test_client_urls() {
        let mainnet = EsploraClient::new_mainnet();
        assert_eq!(mainnet.base_url(), MAINNET_URL);

        let testnet = EsploraClient::new_testnet();
        assert_eq!(testnet.base_url(), TESTNET_URL);
    }
}
