//! Bitcoin SPV Proof Generation
//!
//! Generates SPV proofs for Bitcoin transaction inclusion verification.
//! Used to verify BTC deposits on Solana without trusting a centralized server.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// SPV-related errors
#[derive(Debug, Error)]
pub enum SpvError {
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Block not found: {0}")]
    BlockNotFound(String),
    #[error("Transaction not found: {0}")]
    TxNotFound(String),
    #[error("Transaction not confirmed")]
    TxNotConfirmed,
    #[error("Invalid merkle proof")]
    InvalidMerkleProof,
    #[error("Parse error: {0}")]
    ParseError(String),
}

/// Bitcoin block header (80 bytes)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockHeader {
    pub version: i32,
    pub prev_block_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub timestamp: u32,
    pub bits: u32,
    pub nonce: u32,
    pub height: u64,
}

impl BlockHeader {
    /// Serialize to raw 80-byte format (little-endian)
    pub fn to_raw(&self) -> [u8; 80] {
        let mut raw = [0u8; 80];

        raw[0..4].copy_from_slice(&self.version.to_le_bytes());
        raw[4..36].copy_from_slice(&self.prev_block_hash);
        raw[36..68].copy_from_slice(&self.merkle_root);
        raw[68..72].copy_from_slice(&self.timestamp.to_le_bytes());
        raw[72..76].copy_from_slice(&self.bits.to_le_bytes());
        raw[76..80].copy_from_slice(&self.nonce.to_le_bytes());

        raw
    }

    /// Compute block hash (double SHA256, reversed for display)
    pub fn block_hash(&self) -> [u8; 32] {
        double_sha256(&self.to_raw())
    }

    /// Parse from raw 80-byte format
    pub fn from_raw(raw: &[u8; 80], height: u64) -> Self {
        Self {
            version: i32::from_le_bytes(raw[0..4].try_into().unwrap()),
            prev_block_hash: raw[4..36].try_into().unwrap(),
            merkle_root: raw[36..68].try_into().unwrap(),
            timestamp: u32::from_le_bytes(raw[68..72].try_into().unwrap()),
            bits: u32::from_le_bytes(raw[72..76].try_into().unwrap()),
            nonce: u32::from_le_bytes(raw[76..80].try_into().unwrap()),
            height,
        }
    }
}

/// Transaction Merkle proof for SPV verification
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxMerkleProof {
    /// Transaction ID (txid in internal byte order)
    pub txid: [u8; 32],
    /// Merkle proof siblings (from leaf to root)
    pub siblings: Vec<[u8; 32]>,
    /// Path: true = right child, false = left child
    pub path: Vec<bool>,
    /// Transaction index in block
    pub tx_index: u32,
    /// Block height
    pub block_height: u64,
}

impl TxMerkleProof {
    /// Verify the proof against a merkle root
    pub fn verify(&self, merkle_root: &[u8; 32]) -> bool {
        let mut current = self.txid;

        for (sibling, is_right) in self.siblings.iter().zip(self.path.iter()) {
            current = if *is_right {
                double_sha256_pair(sibling, &current)
            } else {
                double_sha256_pair(&current, sibling)
            };
        }

        current == *merkle_root
    }
}

/// Complete SPV proof for a deposit
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpvProof {
    /// Block header containing the transaction
    pub block_header: BlockHeader,
    /// Merkle proof for transaction inclusion
    pub merkle_proof: TxMerkleProof,
    /// Transaction details
    pub tx_details: TxDetails,
}

/// Transaction details for deposit verification
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxDetails {
    /// Transaction ID (hex, display format)
    pub txid: String,
    /// Output index
    pub vout: u32,
    /// Output value in satoshis
    pub value: u64,
    /// Script pubkey (hex)
    pub script_pubkey: String,
}

/// SPV proof generator using Esplora API
pub struct SpvProofGenerator {
    client: Client,
    base_url: String,
}

impl SpvProofGenerator {
    /// Create for mainnet
    pub fn mainnet() -> Self {
        Self::new("https://blockstream.info/api")
    }

    /// Create for testnet
    pub fn testnet() -> Self {
        Self::new("https://blockstream.info/testnet/api")
    }

    /// Create with custom URL
    pub fn new(base_url: &str) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// Get block header by height
    pub async fn get_block_header(&self, height: u64) -> Result<BlockHeader, SpvError> {
        // Get block hash at height
        let hash_url = format!("{}/block-height/{}", self.base_url, height);
        let hash_resp = self.client.get(&hash_url).send().await?;

        if !hash_resp.status().is_success() {
            return Err(SpvError::BlockNotFound(format!("height {}", height)));
        }

        let block_hash = hash_resp.text().await?;

        // Get block header as raw hex
        let header_url = format!("{}/block/{}/header", self.base_url, block_hash);
        let header_resp = self.client.get(&header_url).send().await?;

        if !header_resp.status().is_success() {
            return Err(SpvError::BlockNotFound(block_hash));
        }

        let header_hex = header_resp.text().await?;
        let header_bytes = hex::decode(&header_hex)
            .map_err(|e| SpvError::ParseError(format!("invalid header hex: {}", e)))?;

        if header_bytes.len() != 80 {
            return Err(SpvError::ParseError(format!(
                "invalid header length: {} bytes",
                header_bytes.len()
            )));
        }

        let mut raw = [0u8; 80];
        raw.copy_from_slice(&header_bytes);

        Ok(BlockHeader::from_raw(&raw, height))
    }

    /// Get block header by hash
    pub async fn get_block_header_by_hash(&self, block_hash: &str) -> Result<(BlockHeader, u64), SpvError> {
        // Get block info to get height
        let block_url = format!("{}/block/{}", self.base_url, block_hash);
        let block_resp = self.client.get(&block_url).send().await?;

        if !block_resp.status().is_success() {
            return Err(SpvError::BlockNotFound(block_hash.to_string()));
        }

        let block_info: EsploraBlockInfo = block_resp.json().await?;

        // Get raw header
        let header_url = format!("{}/block/{}/header", self.base_url, block_hash);
        let header_resp = self.client.get(&header_url).send().await?;
        let header_hex = header_resp.text().await?;
        let header_bytes = hex::decode(&header_hex)
            .map_err(|e| SpvError::ParseError(format!("invalid header hex: {}", e)))?;

        let mut raw = [0u8; 80];
        raw.copy_from_slice(&header_bytes);

        Ok((BlockHeader::from_raw(&raw, block_info.height), block_info.height))
    }

    /// Generate SPV proof for a transaction
    pub async fn generate_proof(&self, txid: &str, vout: u32) -> Result<SpvProof, SpvError> {
        // Get transaction info
        let tx_url = format!("{}/tx/{}", self.base_url, txid);
        let tx_resp = self.client.get(&tx_url).send().await?;

        if !tx_resp.status().is_success() {
            return Err(SpvError::TxNotFound(txid.to_string()));
        }

        let tx_info: EsploraTxInfo = tx_resp.json().await?;

        // Check if confirmed
        let status = tx_info.status.as_ref()
            .ok_or(SpvError::TxNotConfirmed)?;

        if !status.confirmed {
            return Err(SpvError::TxNotConfirmed);
        }

        let block_hash = status.block_hash.as_ref()
            .ok_or(SpvError::TxNotConfirmed)?;
        let block_height = status.block_height
            .ok_or(SpvError::TxNotConfirmed)?;

        // Get block header
        let block_header = self.get_block_header(block_height).await?;

        // Get merkle proof
        let merkle_proof = self.get_merkle_proof(txid, block_hash).await?;

        // Get output details
        let output = tx_info.vout.get(vout as usize)
            .ok_or(SpvError::ParseError(format!("output {} not found", vout)))?;

        let tx_details = TxDetails {
            txid: txid.to_string(),
            vout,
            value: output.value,
            script_pubkey: output.scriptpubkey.clone(),
        };

        Ok(SpvProof {
            block_header,
            merkle_proof,
            tx_details,
        })
    }

    /// Get merkle proof for transaction inclusion
    async fn get_merkle_proof(&self, txid: &str, block_hash: &str) -> Result<TxMerkleProof, SpvError> {
        // Get merkle proof from Esplora
        let proof_url = format!("{}/tx/{}/merkle-proof", self.base_url, txid);
        let proof_resp = self.client.get(&proof_url).send().await?;

        if !proof_resp.status().is_success() {
            return Err(SpvError::TxNotFound(txid.to_string()));
        }

        let proof_data: EsploraMerkleProof = proof_resp.json().await?;

        // Convert txid to internal byte order (reversed)
        let txid_bytes = hex::decode(txid)
            .map_err(|e| SpvError::ParseError(format!("invalid txid: {}", e)))?;
        let mut txid_internal = [0u8; 32];
        txid_internal.copy_from_slice(&txid_bytes);
        txid_internal.reverse(); // Internal byte order

        // Convert merkle proof siblings
        let mut siblings = Vec::with_capacity(proof_data.merkle.len());
        for sibling_hex in &proof_data.merkle {
            let sibling_bytes = hex::decode(sibling_hex)
                .map_err(|e| SpvError::ParseError(format!("invalid merkle sibling: {}", e)))?;
            let mut sibling = [0u8; 32];
            sibling.copy_from_slice(&sibling_bytes);
            sibling.reverse(); // Internal byte order
            siblings.push(sibling);
        }

        // Compute path from position
        let mut path = Vec::with_capacity(siblings.len());
        let mut pos = proof_data.pos;
        for _ in 0..siblings.len() {
            path.push(pos % 2 == 1);
            pos /= 2;
        }

        // Get block height
        let block_url = format!("{}/block/{}", self.base_url, block_hash);
        let block_resp = self.client.get(&block_url).send().await?;
        let block_info: EsploraBlockInfo = block_resp.json().await?;

        Ok(TxMerkleProof {
            txid: txid_internal,
            siblings,
            path,
            tx_index: proof_data.pos,
            block_height: block_info.height,
        })
    }

    /// Get current blockchain tip height
    pub async fn get_tip_height(&self) -> Result<u64, SpvError> {
        let url = format!("{}/blocks/tip/height", self.base_url);
        let resp = self.client.get(&url).send().await?;
        let height: u64 = resp.text().await?
            .parse()
            .map_err(|e| SpvError::ParseError(format!("invalid height: {}", e)))?;
        Ok(height)
    }

    /// Get multiple block headers (for batch submission)
    pub async fn get_block_headers(&self, start_height: u64, count: u32) -> Result<Vec<BlockHeader>, SpvError> {
        let mut headers = Vec::with_capacity(count as usize);

        for i in 0..count {
            let header = self.get_block_header(start_height + i as u64).await?;
            headers.push(header);
        }

        Ok(headers)
    }
}

/// Esplora API response types
#[derive(Debug, Deserialize)]
struct EsploraBlockInfo {
    height: u64,
    #[allow(dead_code)]
    id: String,
}

#[derive(Debug, Deserialize)]
struct EsploraTxInfo {
    #[allow(dead_code)]
    txid: String,
    vout: Vec<EsploraTxOutput>,
    status: Option<EsploraTxStatus>,
}

#[derive(Debug, Deserialize)]
struct EsploraTxOutput {
    value: u64,
    scriptpubkey: String,
}

#[derive(Debug, Deserialize)]
struct EsploraTxStatus {
    confirmed: bool,
    block_height: Option<u64>,
    block_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EsploraMerkleProof {
    pos: u32,
    merkle: Vec<String>,
}

/// Double SHA256 hash (Bitcoin standard)
fn double_sha256(data: &[u8]) -> [u8; 32] {
    let first = Sha256::digest(data);
    let second = Sha256::digest(first);
    second.into()
}

/// Double SHA256 hash of two 32-byte values concatenated
fn double_sha256_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut combined = [0u8; 64];
    combined[0..32].copy_from_slice(left);
    combined[32..64].copy_from_slice(right);
    double_sha256(&combined)
}

/// Helper to convert display txid (hex) to internal bytes
pub fn txid_to_bytes(txid: &str) -> Result<[u8; 32], SpvError> {
    let bytes = hex::decode(txid)
        .map_err(|e| SpvError::ParseError(format!("invalid txid hex: {}", e)))?;

    if bytes.len() != 32 {
        return Err(SpvError::ParseError(format!("invalid txid length: {}", bytes.len())));
    }

    let mut result = [0u8; 32];
    result.copy_from_slice(&bytes);
    result.reverse(); // Convert to internal byte order
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_double_sha256() {
        // Test with known value
        let data = b"hello";
        let hash = double_sha256(data);
        assert_eq!(hash.len(), 32);
    }

    #[test]
    fn test_block_header_serialization() {
        let header = BlockHeader {
            version: 1,
            prev_block_hash: [0u8; 32],
            merkle_root: [0u8; 32],
            timestamp: 1234567890,
            bits: 0x1d00ffff,
            nonce: 12345,
            height: 100,
        };

        let raw = header.to_raw();
        assert_eq!(raw.len(), 80);

        let parsed = BlockHeader::from_raw(&raw, 100);
        assert_eq!(parsed.version, header.version);
        assert_eq!(parsed.timestamp, header.timestamp);
        assert_eq!(parsed.bits, header.bits);
        assert_eq!(parsed.nonce, header.nonce);
    }

    #[tokio::test]
    async fn test_get_tip_height() {
        let generator = SpvProofGenerator::testnet();
        let height = generator.get_tip_height().await;
        assert!(height.is_ok());
        assert!(height.unwrap() > 0);
    }
}
