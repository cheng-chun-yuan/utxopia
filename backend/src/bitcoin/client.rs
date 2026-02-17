//! Esplora API Client for Bitcoin Network Interaction
//!
//! Provides access to Bitcoin blockchain data via the Esplora API.
//! Used for checking transaction confirmations, broadcasting transactions,
//! and fetching block data.

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

    /// Get address UTXOs
    pub async fn get_address_utxos(&self, address: &str) -> Result<Vec<UtxoInfo>, EsploraError> {
        let url = format!("{}/address/{}/utxo", self.base_url, address);
        let resp = self.client.get(&url).send().await?;

        if !resp.status().is_success() {
            return Err(EsploraError::AddressNotFound(address.to_string()));
        }

        let utxos: Vec<EsploraUtxo> = resp.json().await?;

        let current_height = self.get_block_height().await?;

        Ok(utxos
            .into_iter()
            .map(|u| {
                let confirmations = if let Some(height) = u.status.block_height {
                    (current_height.saturating_sub(height) + 1) as u32
                } else {
                    0
                };

                UtxoInfo {
                    txid: u.txid,
                    vout: u.vout,
                    value: u.value,
                    confirmations,
                    block_height: u.status.block_height,
                }
            })
            .collect())
    }

    /// Get raw transaction hex
    pub async fn get_tx_hex(&self, txid: &str) -> Result<String, EsploraError> {
        let url = format!("{}/tx/{}/hex", self.base_url, txid);
        let resp = self.client.get(&url).send().await?;

        if !resp.status().is_success() {
            return Err(EsploraError::TxNotFound(txid.to_string()));
        }

        Ok(resp.text().await?)
    }

    /// Get block header by height
    pub async fn get_block_header(&self, height: u64) -> Result<BlockHeaderInfo, EsploraError> {
        // Get block hash at height
        let hash_url = format!("{}/block-height/{}", self.base_url, height);
        let hash_resp = self.client.get(&hash_url).send().await?;

        if !hash_resp.status().is_success() {
            return Err(EsploraError::BlockNotFound(format!("height {}", height)));
        }

        let block_hash = hash_resp.text().await?;

        // Get raw header
        let header_url = format!("{}/block/{}/header", self.base_url, block_hash);
        let header_resp = self.client.get(&header_url).send().await?;
        let header_hex = header_resp.text().await?;

        Ok(BlockHeaderInfo {
            height,
            hash: block_hash,
            header_hex,
        })
    }

    /// Get merkle proof for a transaction
    pub async fn get_merkle_proof(&self, txid: &str) -> Result<MerkleProofInfo, EsploraError> {
        let url = format!("{}/tx/{}/merkle-proof", self.base_url, txid);
        let resp = self.client.get(&url).send().await?;

        if !resp.status().is_success() {
            return Err(EsploraError::TxNotFound(txid.to_string()));
        }

        let proof: EsploraMerkleProof = resp.json().await?;

        Ok(MerkleProofInfo {
            block_height: proof.block_height,
            merkle: proof.merkle,
            pos: proof.pos,
        })
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

/// UTXO information from Esplora
#[derive(Debug, Clone, Deserialize)]
struct EsploraUtxo {
    txid: String,
    vout: u32,
    value: u64,
    status: EsploraTxStatus,
}

/// Merkle proof from Esplora
#[derive(Debug, Clone, Deserialize)]
struct EsploraMerkleProof {
    block_height: u64,
    merkle: Vec<String>,
    pos: u32,
}

/// UTXO information
#[derive(Debug, Clone)]
pub struct UtxoInfo {
    pub txid: String,
    pub vout: u32,
    pub value: u64,
    pub confirmations: u32,
    pub block_height: Option<u64>,
}

/// Block header information
#[derive(Debug, Clone)]
pub struct BlockHeaderInfo {
    pub height: u64,
    pub hash: String,
    pub header_hex: String,
}

/// Merkle proof information
#[derive(Debug, Clone)]
pub struct MerkleProofInfo {
    pub block_height: u64,
    pub merkle: Vec<String>,
    pub pos: u32,
}

/// Esplora error types
#[derive(Debug, thiserror::Error)]
pub enum EsploraError {
    #[error("HTTP request failed: {0}")]
    HttpError(#[from] reqwest::Error),

    #[error("Transaction not found: {0}")]
    TxNotFound(String),

    #[error("Address not found: {0}")]
    AddressNotFound(String),

    #[error("Block not found: {0}")]
    BlockNotFound(String),

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
