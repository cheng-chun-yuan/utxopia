//! Address Watcher
//!
//! Polls Esplora API to monitor Bitcoin addresses for incoming deposits.
//! Tracks transaction confirmations and provides merkle proof data.

use reqwest::Client;
use serde::Deserialize;
use thiserror::Error;

/// Esplora API endpoints
pub const MAINNET_URL: &str = "https://blockstream.info/api";
pub const TESTNET_URL: &str = "https://blockstream.info/testnet/api";

/// Watcher errors
#[derive(Debug, Error)]
pub enum WatcherError {
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Address not found: {0}")]
    AddressNotFound(String),

    #[error("Transaction not found: {0}")]
    TxNotFound(String),

    #[error("Parse error: {0}")]
    ParseError(String),
}

/// Result of checking an address for deposits
#[derive(Debug, Clone)]
pub struct AddressStatus {
    /// Address that was checked
    pub address: String,
    /// Total funded amount in satoshis
    pub funded_sats: u64,
    /// Number of transactions to this address
    pub tx_count: u32,
    /// Unspent transaction outputs
    pub utxos: Vec<Utxo>,
}

/// Unspent transaction output
#[derive(Debug, Clone, PartialEq)]
pub struct Utxo {
    /// Transaction ID
    pub txid: String,
    /// Output index
    pub vout: u32,
    /// Value in satoshis
    pub value: u64,
    /// Block height (None if unconfirmed)
    pub block_height: Option<u64>,
    /// Number of confirmations
    pub confirmations: u32,
}

/// Transaction confirmation status
#[derive(Debug, Clone)]
pub struct TxConfirmation {
    pub txid: String,
    pub confirmed: bool,
    pub block_height: Option<u64>,
    pub block_hash: Option<String>,
    pub confirmations: u32,
}

/// Address watcher that polls Esplora
#[derive(Debug, Clone)]
pub struct AddressWatcher {
    client: Client,
    base_url: String,
}

impl AddressWatcher {
    /// Create watcher for mainnet
    pub fn mainnet() -> Self {
        Self::new(MAINNET_URL)
    }

    /// Create watcher for testnet
    pub fn testnet() -> Self {
        Self::new(TESTNET_URL)
    }

    /// Create with custom URL
    pub fn new(base_url: &str) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// Get current blockchain tip height
    pub async fn get_tip_height(&self) -> Result<u64, WatcherError> {
        let url = format!("{}/blocks/tip/height", self.base_url);
        let resp = self.client.get(&url).send().await?;

        let height: u64 = resp
            .text()
            .await?
            .parse()
            .map_err(|e| WatcherError::ParseError(format!("invalid height: {}", e)))?;

        Ok(height)
    }

    /// Check address for deposits and get UTXOs
    pub async fn check_address(&self, address: &str) -> Result<AddressStatus, WatcherError> {
        // Get address info
        let addr_url = format!("{}/address/{}", self.base_url, address);
        let addr_resp = self.client.get(&addr_url).send().await?;

        if !addr_resp.status().is_success() {
            return Err(WatcherError::AddressNotFound(address.to_string()));
        }

        let addr_info: EsploraAddressInfo = addr_resp.json().await?;

        // Get UTXOs
        let utxo_url = format!("{}/address/{}/utxo", self.base_url, address);
        let utxo_resp = self.client.get(&utxo_url).send().await?;
        let utxos_raw: Vec<EsploraUtxo> = utxo_resp.json().await?;

        // Get current height for confirmation calculation
        let tip_height = self.get_tip_height().await?;

        // Convert UTXOs
        let utxos: Vec<Utxo> = utxos_raw
            .into_iter()
            .map(|u| {
                let confirmations = if let Some(height) = u.status.block_height {
                    (tip_height.saturating_sub(height) + 1) as u32
                } else {
                    0
                };

                Utxo {
                    txid: u.txid,
                    vout: u.vout,
                    value: u.value,
                    block_height: u.status.block_height,
                    confirmations,
                }
            })
            .collect();

        let funded_sats = utxos.iter().map(|u| u.value).sum();

        Ok(AddressStatus {
            address: address.to_string(),
            funded_sats,
            tx_count: addr_info.chain_stats.tx_count,
            utxos,
        })
    }

    /// Get confirmation status for a specific transaction
    pub async fn get_tx_confirmations(&self, txid: &str) -> Result<TxConfirmation, WatcherError> {
        let status_url = format!("{}/tx/{}/status", self.base_url, txid);
        let resp = self.client.get(&status_url).send().await?;

        if !resp.status().is_success() {
            return Err(WatcherError::TxNotFound(txid.to_string()));
        }

        let status: EsploraTxStatus = resp.json().await?;

        let confirmations = if status.confirmed {
            if let Some(height) = status.block_height {
                let tip = self.get_tip_height().await?;
                (tip.saturating_sub(height) + 1) as u32
            } else {
                1
            }
        } else {
            0
        };

        Ok(TxConfirmation {
            txid: txid.to_string(),
            confirmed: status.confirmed,
            block_height: status.block_height,
            block_hash: status.block_hash,
            confirmations,
        })
    }

    /// Get raw transaction hex
    pub async fn get_tx_hex(&self, txid: &str) -> Result<String, WatcherError> {
        let url = format!("{}/tx/{}/hex", self.base_url, txid);
        let resp = self.client.get(&url).send().await?;

        if !resp.status().is_success() {
            return Err(WatcherError::TxNotFound(txid.to_string()));
        }

        let hex = resp.text().await?;
        Ok(hex)
    }

    /// Get transaction details
    pub async fn get_tx(&self, txid: &str) -> Result<EsploraTxFull, WatcherError> {
        let url = format!("{}/tx/{}", self.base_url, txid);
        let resp = self.client.get(&url).send().await?;

        if !resp.status().is_success() {
            return Err(WatcherError::TxNotFound(txid.to_string()));
        }

        let tx: EsploraTxFull = resp.json().await?;
        Ok(tx)
    }

    /// Broadcast a raw transaction
    pub async fn broadcast_tx(&self, tx_hex: &str) -> Result<String, WatcherError> {
        let url = format!("{}/tx", self.base_url);
        let resp = self.client.post(&url).body(tx_hex.to_string()).send().await?;

        if !resp.status().is_success() {
            let error_text = resp.text().await.unwrap_or_default();
            return Err(WatcherError::ParseError(format!(
                "Broadcast failed: {}",
                error_text
            )));
        }

        let txid = resp.text().await?;
        Ok(txid)
    }

    /// Get merkle proof for SPV verification
    pub async fn get_merkle_proof(&self, txid: &str) -> Result<MerkleProofData, WatcherError> {
        let proof_url = format!("{}/tx/{}/merkle-proof", self.base_url, txid);
        let resp = self.client.get(&proof_url).send().await?;

        if !resp.status().is_success() {
            return Err(WatcherError::TxNotFound(txid.to_string()));
        }

        let proof: EsploraMerkleProof = resp.json().await?;

        Ok(MerkleProofData {
            txid: txid.to_string(),
            block_height: proof.block_height,
            merkle: proof.merkle,
            pos: proof.pos,
        })
    }

    /// Get block header by height
    pub async fn get_block_header(&self, height: u64) -> Result<BlockHeaderData, WatcherError> {
        // Get block hash at height
        let hash_url = format!("{}/block-height/{}", self.base_url, height);
        let hash_resp = self.client.get(&hash_url).send().await?;

        if !hash_resp.status().is_success() {
            return Err(WatcherError::ParseError(format!(
                "Block not found at height {}",
                height
            )));
        }

        let block_hash = hash_resp.text().await?;

        // Get block header as raw hex
        let header_url = format!("{}/block/{}/header", self.base_url, block_hash);
        let header_resp = self.client.get(&header_url).send().await?;
        let header_hex = header_resp.text().await?;

        Ok(BlockHeaderData {
            height,
            hash: block_hash,
            header_hex,
        })
    }
}

/// Merkle proof data for SPV
#[derive(Debug, Clone)]
pub struct MerkleProofData {
    pub txid: String,
    pub block_height: u64,
    pub merkle: Vec<String>,
    pub pos: u32,
}

/// Block header data
#[derive(Debug, Clone)]
pub struct BlockHeaderData {
    pub height: u64,
    pub hash: String,
    pub header_hex: String,
}

// =============================================================================
// Esplora API Response Types
// =============================================================================

#[derive(Debug, Deserialize)]
pub struct EsploraAddressInfo {
    pub chain_stats: ChainStats,
}

#[derive(Debug, Deserialize)]
pub struct ChainStats {
    pub funded_txo_count: u32,
    pub funded_txo_sum: u64,
    pub spent_txo_count: u32,
    pub spent_txo_sum: u64,
    pub tx_count: u32,
}

#[derive(Debug, Deserialize)]
pub struct EsploraUtxo {
    pub txid: String,
    pub vout: u32,
    pub value: u64,
    pub status: EsploraTxStatus,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EsploraTxStatus {
    pub confirmed: bool,
    pub block_height: Option<u64>,
    pub block_hash: Option<String>,
    pub block_time: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct EsploraMerkleProof {
    pub block_height: u64,
    pub merkle: Vec<String>,
    pub pos: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EsploraTxFull {
    pub txid: String,
    pub version: i32,
    pub locktime: u32,
    pub vin: Vec<EsploraTxInput>,
    pub vout: Vec<EsploraTxOutput>,
    pub size: u32,
    pub weight: u32,
    pub fee: u64,
    pub status: EsploraTxStatus,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EsploraTxInput {
    pub txid: String,
    pub vout: u32,
    pub prevout: Option<EsploraTxOutput>,
    pub scriptsig: String,
    pub scriptsig_asm: String,
    pub witness: Option<Vec<String>>,
    pub is_coinbase: bool,
    pub sequence: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EsploraTxOutput {
    pub scriptpubkey: String,
    pub scriptpubkey_asm: String,
    pub scriptpubkey_type: String,
    pub scriptpubkey_address: Option<String>,
    pub value: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_get_tip_height() {
        let watcher = AddressWatcher::testnet();
        let height = watcher.get_tip_height().await;
        assert!(height.is_ok());
        assert!(height.unwrap() > 0);
    }

    #[tokio::test]
    async fn test_check_invalid_address() {
        let watcher = AddressWatcher::testnet();
        let result = watcher.check_address("invalid_address").await;
        // Should return an error for invalid address
        assert!(result.is_err());
    }
}
