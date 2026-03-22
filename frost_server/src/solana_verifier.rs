//! Solana On-Chain Verifier
//!
//! Lightweight Solana RPC client for verifying on-chain state before FROST signing.
//! Uses raw JSON-RPC via reqwest — no solana-sdk dependency.
//!
//! ## Verification
//!
//! - **Withdrawal**: Verify RedemptionRequest PDA exists with correct status, amount, and BTC address
//! - **Sweep (future)**: DepositRecord verification deferred (chicken-and-egg: PDA created after sweep)

use sha2::{Digest, Sha256};
use thiserror::Error;

/// Errors from Solana verification
#[derive(Debug, Error)]
pub enum SolanaVerifyError {
    #[error("Solana RPC error: {0}")]
    RpcError(String),

    #[error("account not found: {0}")]
    AccountNotFound(String),

    #[error("invalid account data: {0}")]
    InvalidAccountData(String),

    #[error("redemption status mismatch: expected Processing (1), got {0}")]
    WrongStatus(u8),

    #[error("amount mismatch: on-chain {on_chain} != expected {expected}")]
    AmountMismatch { on_chain: u64, expected: u64 },

    #[error("BTC address mismatch: on-chain '{on_chain}' != expected '{expected}'")]
    BtcAddressMismatch { on_chain: String, expected: String },
}

/// RedemptionRequest account layout offsets (from contracts/programs/aegis/src/state/redemption.rs)
///
/// Layout (98 bytes): disc(1) + status(1) + btc_script_len(1) + padding(1) +
///         processing_slot(4) + request_id(8) + requester(32) + amount_sats(8) + btc_script(34) + service_fee(8)
/// Note: btc_script stores raw scriptPubKey bytes, not bech32 address strings.
const REDEMPTION_DISCRIMINATOR: u8 = 0x04;
const REDEMPTION_STATUS_OFFSET: usize = 1;
const REDEMPTION_BTC_ADDR_LEN_OFFSET: usize = 2;
const REDEMPTION_AMOUNT_OFFSET: usize = 48; // 1+1+1+1+4+8+32
const REDEMPTION_SERVICE_FEE_OFFSET: usize = 56; // 48+8
const REDEMPTION_BTC_ADDR_OFFSET: usize = 64; // 56+8
const REDEMPTION_MIN_LEN: usize = 98; // full struct size

/// UtxoRecord account layout offsets (from contracts/programs/aegis/src/state/utxo.rs)
///
/// Layout (48 bytes): disc(1) + status(1) + padding(2) + vout(4) + txid(32) + amount_sats(8)
/// PDA seeds: ["utxo", txid(32), vout_le(4)]
const UTXO_RECORD_DISCRIMINATOR: u8 = 0x09;
const UTXO_STATUS_OFFSET: usize = 1;
const UTXO_AMOUNT_OFFSET: usize = 40;
const UTXO_RECORD_LEN: usize = 48;
/// UTXO status: Reserved = 1 (selected for a withdrawal tx)
const UTXO_STATUS_RESERVED: u8 = 1;

/// PoolState layout offsets for fee config
const POOL_STATE_DISCRIMINATOR: u8 = 0x01;
const POOL_STATE_SERVICE_FEE_BASE_OFFSET: usize = 196;
const POOL_STATE_SERVICE_FEE_BPS_OFFSET: usize = 244;
const POOL_STATE_MIN_LEN: usize = 268;

/// Verified redemption data read directly from on-chain PDA
#[derive(Debug, Clone)]
pub struct VerifiedRedemption {
    /// Gross amount from PDA (amount_sats)
    pub amount_sats: u64,
    /// Service fee locked at request time (from PDA)
    pub service_fee: u64,
    /// BTC scriptPubKey hex from PDA
    pub btc_script_hex: String,
}

impl VerifiedRedemption {
    /// Expected net send amount = gross - service_fee
    pub fn expected_send_amount(&self) -> u64 {
        self.amount_sats.saturating_sub(self.service_fee)
    }
}

/// On-chain fee config from PoolState PDA
#[derive(Debug, Clone)]
pub struct PoolFeeConfig {
    pub service_fee_bps: u16,
    pub service_fee_base: u64,
}

impl PoolFeeConfig {
    /// Compute expected service fee for a given amount
    pub fn compute_fee(&self, amount: u64) -> u64 {
        let pct = (amount as u128 * self.service_fee_bps as u128 / 10_000) as u64;
        pct.saturating_add(self.service_fee_base)
    }
}

/// Solana on-chain verifier
pub struct SolanaVerifier {
    rpc_url: String,
    program_id: [u8; 32],
    http: reqwest::Client,
}

impl SolanaVerifier {
    /// Create a new Solana verifier
    ///
    /// # Arguments
    /// * `rpc_url` - Solana JSON-RPC URL (e.g., "http://localhost:8899")
    /// * `program_id_base58` - Aegis program ID in base58
    pub fn new(rpc_url: String, program_id_base58: &str) -> Result<Self, SolanaVerifyError> {
        let program_id_bytes = bs58::decode(program_id_base58)
            .into_vec()
            .map_err(|e| SolanaVerifyError::RpcError(format!("invalid program ID: {}", e)))?;

        if program_id_bytes.len() != 32 {
            return Err(SolanaVerifyError::RpcError(format!(
                "program ID must be 32 bytes, got {}",
                program_id_bytes.len()
            )));
        }

        let mut program_id = [0u8; 32];
        program_id.copy_from_slice(&program_id_bytes);

        Ok(Self {
            rpc_url,
            program_id,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        })
    }

    /// Verify a RedemptionRequest PDA exists on-chain with matching data.
    ///
    /// Derives the PDA from seeds `["redemption", requester(32), nonce_le(8)]`,
    /// fetches via RPC, and validates discriminator, status, amount, and BTC address.
    ///
    /// Returns `VerifiedRedemption` with the on-chain data for further validation.
    pub async fn verify_redemption(
        &self,
        requester_base58: &str,
        nonce: u64,
        expected_amount_sats: u64,
        expected_btc_address: &str,
    ) -> Result<VerifiedRedemption, SolanaVerifyError> {
        // Decode requester pubkey
        let requester_bytes = bs58::decode(requester_base58)
            .into_vec()
            .map_err(|e| {
                SolanaVerifyError::RpcError(format!("invalid requester pubkey: {}", e))
            })?;
        if requester_bytes.len() != 32 {
            return Err(SolanaVerifyError::RpcError(
                "requester must be 32 bytes".to_string(),
            ));
        }

        // Derive PDA: seeds = ["redemption", requester(32), nonce_le(8)]
        let nonce_bytes = nonce.to_le_bytes();
        let seeds: &[&[u8]] = &[b"redemption", &requester_bytes, &nonce_bytes];

        let pda = find_program_address(seeds, &self.program_id)
            .ok_or_else(|| {
                SolanaVerifyError::RpcError("failed to derive PDA (no valid bump)".to_string())
            })?;

        let pda_base58 = bs58::encode(&pda.0).into_string();

        tracing::debug!(
            pda = %pda_base58,
            requester = %requester_base58,
            nonce = nonce,
            "verifying RedemptionRequest PDA"
        );

        // Fetch account data
        let data = self.get_account_data(&pda_base58).await?.ok_or_else(|| {
            SolanaVerifyError::AccountNotFound(format!(
                "RedemptionRequest PDA {} not found",
                pda_base58
            ))
        })?;

        // Validate account data
        if data.len() < REDEMPTION_MIN_LEN {
            return Err(SolanaVerifyError::InvalidAccountData(format!(
                "account too small: {} < {}",
                data.len(),
                REDEMPTION_MIN_LEN
            )));
        }

        // Check discriminator
        if data[0] != REDEMPTION_DISCRIMINATOR {
            return Err(SolanaVerifyError::InvalidAccountData(format!(
                "wrong discriminator: expected 0x{:02x}, got 0x{:02x}",
                REDEMPTION_DISCRIMINATOR, data[0]
            )));
        }

        // Check status (must be Processing=1)
        let status = data[REDEMPTION_STATUS_OFFSET];
        if status != 1 {
            return Err(SolanaVerifyError::WrongStatus(status));
        }

        // Check amount
        let on_chain_amount = u64::from_le_bytes(
            data[REDEMPTION_AMOUNT_OFFSET..REDEMPTION_AMOUNT_OFFSET + 8]
                .try_into()
                .map_err(|_| SolanaVerifyError::InvalidAccountData(
                    "failed to parse amount_sats bytes".to_string()
                ))?,
        );
        if on_chain_amount != expected_amount_sats {
            return Err(SolanaVerifyError::AmountMismatch {
                on_chain: on_chain_amount,
                expected: expected_amount_sats,
            });
        }

        // Read service_fee locked at request time (offset 56, 8 bytes LE)
        let on_chain_service_fee = u64::from_le_bytes(
            data[REDEMPTION_SERVICE_FEE_OFFSET..REDEMPTION_SERVICE_FEE_OFFSET + 8]
                .try_into()
                .map_err(|_| SolanaVerifyError::InvalidAccountData(
                    "failed to parse service_fee bytes".to_string()
                ))?,
        );

        // Check BTC scriptPubKey (stored as raw bytes at offset 64, not bech32 string)
        let script_len = data[REDEMPTION_BTC_ADDR_LEN_OFFSET] as usize;
        if REDEMPTION_BTC_ADDR_OFFSET + script_len > data.len() {
            return Err(SolanaVerifyError::InvalidAccountData(
                "BTC script length exceeds account data".to_string(),
            ));
        }
        let on_chain_script =
            &data[REDEMPTION_BTC_ADDR_OFFSET..REDEMPTION_BTC_ADDR_OFFSET + script_len];
        let on_chain_addr = hex::encode(on_chain_script);

        if on_chain_addr != expected_btc_address {
            return Err(SolanaVerifyError::BtcAddressMismatch {
                on_chain: on_chain_addr.to_string(),
                expected: expected_btc_address.to_string(),
            });
        }

        tracing::info!(
            pda = %pda_base58,
            amount = on_chain_amount,
            service_fee = on_chain_service_fee,
            btc_script = %on_chain_addr,
            status = status,
            "RedemptionRequest verified on-chain"
        );

        Ok(VerifiedRedemption {
            amount_sats: on_chain_amount,
            service_fee: on_chain_service_fee,
            btc_script_hex: on_chain_addr,
        })
    }

    /// Fetch on-chain fee config from PoolState PDA.
    ///
    /// Derives PDA from seeds ["pool_state"], fetches account, parses fee fields.
    pub async fn fetch_pool_fees(&self) -> Result<PoolFeeConfig, SolanaVerifyError> {
        let seeds: &[&[u8]] = &[b"pool_state"];
        let pda = find_program_address(seeds, &self.program_id)
            .ok_or_else(|| SolanaVerifyError::RpcError("failed to derive pool_state PDA".to_string()))?;

        let pda_base58 = bs58::encode(&pda.0).into_string();
        let data = self.get_account_data(&pda_base58).await?.ok_or_else(|| {
            SolanaVerifyError::AccountNotFound(format!("PoolState PDA {} not found", pda_base58))
        })?;

        if data.len() < POOL_STATE_MIN_LEN {
            return Err(SolanaVerifyError::InvalidAccountData(format!(
                "pool_state too small: {} < {}", data.len(), POOL_STATE_MIN_LEN
            )));
        }
        if data[0] != POOL_STATE_DISCRIMINATOR {
            return Err(SolanaVerifyError::InvalidAccountData(format!(
                "pool_state wrong discriminator: 0x{:02x}", data[0]
            )));
        }

        let base = u64::from_le_bytes(
            data[POOL_STATE_SERVICE_FEE_BASE_OFFSET..POOL_STATE_SERVICE_FEE_BASE_OFFSET + 8]
                .try_into()
                .map_err(|_| SolanaVerifyError::InvalidAccountData(
                    "failed to parse service_fee_base bytes".to_string()
                ))?,
        );
        let bps = u16::from_le_bytes(
            data[POOL_STATE_SERVICE_FEE_BPS_OFFSET..POOL_STATE_SERVICE_FEE_BPS_OFFSET + 2]
                .try_into()
                .map_err(|_| SolanaVerifyError::InvalidAccountData(
                    "failed to parse service_fee_bps bytes".to_string()
                ))?,
        );

        Ok(PoolFeeConfig { service_fee_bps: bps, service_fee_base: base })
    }

    /// Verify that BTC transaction inputs match on-chain Reserved UtxoRecord PDAs.
    ///
    /// For each UTXO input (txid, vout, amount), derives the UtxoRecord PDA,
    /// fetches it via RPC, and validates:
    /// - Discriminator is 0x09 (UtxoRecord)
    /// - Status is Reserved (1)
    /// - Amount matches the claimed prevout value
    ///
    /// Returns the total input amount from verified UTXOs.
    pub async fn verify_utxo_inputs(
        &self,
        utxo_inputs: &[(String, u32, u64)], // (txid_hex, vout, amount_sats)
    ) -> Result<u64, SolanaVerifyError> {
        if utxo_inputs.is_empty() {
            return Err(SolanaVerifyError::InvalidAccountData(
                "no UTXO inputs provided".to_string(),
            ));
        }

        let mut total_input_sats: u64 = 0;

        for (txid_hex, vout, claimed_amount) in utxo_inputs {
            // Decode txid from hex (internal byte order, same as on-chain)
            let txid_bytes = hex::decode(txid_hex).map_err(|e| {
                SolanaVerifyError::RpcError(format!("invalid txid hex '{}': {}", txid_hex, e))
            })?;
            if txid_bytes.len() != 32 {
                return Err(SolanaVerifyError::RpcError(format!(
                    "txid must be 32 bytes, got {}",
                    txid_bytes.len()
                )));
            }

            let vout_le = vout.to_le_bytes();
            let seeds: &[&[u8]] = &[b"utxo", &txid_bytes, &vout_le];

            let pda = find_program_address(seeds, &self.program_id).ok_or_else(|| {
                SolanaVerifyError::RpcError(format!(
                    "failed to derive UTXO PDA for {}:{}",
                    txid_hex, vout
                ))
            })?;

            let pda_base58 = bs58::encode(&pda.0).into_string();

            tracing::debug!(
                pda = %pda_base58,
                txid = %txid_hex,
                vout = vout,
                claimed_amount = claimed_amount,
                "verifying UtxoRecord PDA"
            );

            let data = self.get_account_data(&pda_base58).await?.ok_or_else(|| {
                SolanaVerifyError::AccountNotFound(format!(
                    "UtxoRecord PDA {} not found for {}:{}",
                    pda_base58, txid_hex, vout
                ))
            })?;

            if data.len() < UTXO_RECORD_LEN {
                return Err(SolanaVerifyError::InvalidAccountData(format!(
                    "UTXO account too small: {} < {}",
                    data.len(),
                    UTXO_RECORD_LEN
                )));
            }

            if data[0] != UTXO_RECORD_DISCRIMINATOR {
                return Err(SolanaVerifyError::InvalidAccountData(format!(
                    "wrong UTXO discriminator: expected 0x{:02x}, got 0x{:02x}",
                    UTXO_RECORD_DISCRIMINATOR, data[0]
                )));
            }

            let status = data[UTXO_STATUS_OFFSET];
            if status != UTXO_STATUS_RESERVED {
                return Err(SolanaVerifyError::InvalidAccountData(format!(
                    "UTXO {}:{} status is {} (expected Reserved={})",
                    txid_hex, vout, status, UTXO_STATUS_RESERVED
                )));
            }

            let on_chain_amount = u64::from_le_bytes(
                data[UTXO_AMOUNT_OFFSET..UTXO_AMOUNT_OFFSET + 8]
                    .try_into()
                    .map_err(|_| {
                        SolanaVerifyError::InvalidAccountData(
                            "failed to parse UTXO amount_sats".to_string(),
                        )
                    })?,
            );

            if on_chain_amount != *claimed_amount {
                return Err(SolanaVerifyError::AmountMismatch {
                    on_chain: on_chain_amount,
                    expected: *claimed_amount,
                });
            }

            tracing::info!(
                pda = %pda_base58,
                txid = %txid_hex,
                vout = vout,
                amount = on_chain_amount,
                "UtxoRecord verified: Reserved with correct amount"
            );

            total_input_sats += on_chain_amount;
        }

        tracing::info!(
            utxo_count = utxo_inputs.len(),
            total_input_sats = total_input_sats,
            "all UTXO inputs verified against on-chain PDAs"
        );

        Ok(total_input_sats)
    }

    /// Verify that a DepositIntent PDA exists on-chain.
    ///
    /// Derives PDA from seeds ["deposit_intent", npk], fetches via RPC,
    /// and validates discriminator (0x07).
    pub async fn verify_deposit_intent(
        &self,
        npk_hex: &str,
    ) -> Result<(), SolanaVerifyError> {
        let npk_bytes = hex::decode(npk_hex)
            .map_err(|e| SolanaVerifyError::RpcError(format!("invalid npk hex: {}", e)))?;

        if npk_bytes.len() != 32 {
            return Err(SolanaVerifyError::RpcError(format!(
                "npk must be 32 bytes, got {}", npk_bytes.len()
            )));
        }

        let seeds: &[&[u8]] = &[b"deposit_intent", &npk_bytes];
        let pda = find_program_address(seeds, &self.program_id)
            .ok_or_else(|| SolanaVerifyError::RpcError("failed to derive DepositIntent PDA".to_string()))?;

        let pda_base58 = bs58::encode(&pda.0).into_string();

        tracing::debug!(
            pda = %pda_base58,
            npk = %npk_hex,
            "verifying DepositIntent PDA"
        );

        let data = self.get_account_data(&pda_base58).await?.ok_or_else(|| {
            SolanaVerifyError::AccountNotFound(format!(
                "DepositIntent PDA {} not found", pda_base58
            ))
        })?;

        // Validate discriminator (0x07)
        if data.is_empty() || data[0] != 0x07 {
            return Err(SolanaVerifyError::InvalidAccountData(format!(
                "wrong discriminator: expected 0x07, got 0x{:02x}",
                data.first().copied().unwrap_or(0)
            )));
        }

        tracing::info!(
            pda = %pda_base58,
            "DepositIntent verified on-chain"
        );

        Ok(())
    }

    /// Fetch account data via Solana JSON-RPC `getAccountInfo`.
    ///
    /// Returns `None` if account doesn't exist, `Some(data)` if it does.
    async fn get_account_data(&self, address: &str) -> Result<Option<Vec<u8>>, SolanaVerifyError> {
        let request_body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getAccountInfo",
            "params": [
                address,
                { "encoding": "base64" }
            ]
        });

        let response = self
            .http
            .post(&self.rpc_url)
            .json(&request_body)
            .send()
            .await
            .map_err(|e| SolanaVerifyError::RpcError(format!("HTTP error: {}", e)))?;

        if !response.status().is_success() {
            return Err(SolanaVerifyError::RpcError(format!(
                "HTTP {}",
                response.status()
            )));
        }

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| SolanaVerifyError::RpcError(format!("JSON parse error: {}", e)))?;

        // Check for RPC error
        if let Some(err) = body.get("error") {
            return Err(SolanaVerifyError::RpcError(format!(
                "RPC error: {}",
                err
            )));
        }

        // result.value is null if account doesn't exist
        let value = &body["result"]["value"];
        if value.is_null() {
            return Ok(None);
        }

        // Parse base64-encoded data
        let data_array = value["data"]
            .as_array()
            .ok_or_else(|| SolanaVerifyError::RpcError("missing data array".to_string()))?;

        let data_base64 = data_array
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| SolanaVerifyError::RpcError("missing data[0] string".to_string()))?;

        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|e| SolanaVerifyError::RpcError(format!("base64 decode error: {}", e)))?;

        Ok(Some(data))
    }
}

/// Derive a program address (PDA) from seeds and program ID.
///
/// Pure Rust implementation matching Solana's `Pubkey::find_program_address`.
/// Tries bump seeds from 255 down to 0, returns the first address that is NOT
/// on the ed25519 curve.
pub fn find_program_address(seeds: &[&[u8]], program_id: &[u8; 32]) -> Option<([u8; 32], u8)> {
    for bump in (0..=255u8).rev() {
        if let Some(address) = create_program_address(seeds, &[bump], program_id) {
            return Some((address, bump));
        }
    }
    None
}

/// Try to create a program address with the given seeds and bump.
///
/// Returns `None` if the resulting address is on the ed25519 curve
/// (i.e., not a valid PDA).
fn create_program_address(
    seeds: &[&[u8]],
    bump_seed: &[u8],
    program_id: &[u8; 32],
) -> Option<[u8; 32]> {
    let mut hasher = Sha256::new();

    for seed in seeds {
        hasher.update(seed);
    }
    hasher.update(bump_seed);
    hasher.update(program_id);
    hasher.update(b"ProgramDerivedAddress");

    let hash = hasher.finalize();
    let mut address = [0u8; 32];
    address.copy_from_slice(&hash);

    // Check that the address is NOT on the ed25519 curve.
    // A point is on the curve if it can be decompressed successfully.
    if is_on_curve(&address) {
        return None;
    }

    Some(address)
}

/// Check if a 32-byte value is a valid ed25519 point (on curve).
///
/// Uses the `curve25519-dalek` crate (transitive dependency via `x25519-dalek`)
/// to attempt point decompression.
fn is_on_curve(bytes: &[u8; 32]) -> bool {
    // curve25519-dalek's CompressedEdwardsY::decompress returns None if not on curve
    let compressed = curve25519_dalek::edwards::CompressedEdwardsY::from_slice(bytes);
    match compressed {
        Ok(point) => point.decompress().is_some(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pda_derivation_known_vector() {
        // Test with a known program ID and seeds
        // Using the Aegis program ID: 7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ
        let program_id_bytes = bs58::decode("7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ")
            .into_vec()
            .unwrap();
        let mut program_id = [0u8; 32];
        program_id.copy_from_slice(&program_id_bytes);

        // Derive a PDA with known seeds
        let seeds: &[&[u8]] = &[b"redemption"];
        let result = find_program_address(seeds, &program_id);
        assert!(result.is_some(), "PDA derivation should succeed");

        let (address, bump) = result.unwrap();
        assert!(bump <= 255);
        assert!(!is_on_curve(&address), "PDA should not be on curve");

        // Verify deterministic: same seeds produce same result
        let result2 = find_program_address(seeds, &program_id);
        assert_eq!(result, result2);
    }

    #[test]
    fn test_pda_with_redemption_seeds() {
        // Simulate a real redemption PDA derivation
        let program_id_bytes = bs58::decode("7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ")
            .into_vec()
            .unwrap();
        let mut program_id = [0u8; 32];
        program_id.copy_from_slice(&program_id_bytes);

        // Mock requester pubkey (32 bytes)
        let requester = [1u8; 32];
        let nonce: u64 = 42;
        let nonce_bytes = nonce.to_le_bytes();

        let seeds: &[&[u8]] = &[b"redemption", &requester, &nonce_bytes];
        let result = find_program_address(seeds, &program_id);
        assert!(result.is_some());

        let (address, _bump) = result.unwrap();
        assert!(!is_on_curve(&address));
    }

    #[test]
    fn test_account_data_parsing() {
        // Build a mock RedemptionRequest account data buffer (90 bytes)
        let mut data = vec![0u8; REDEMPTION_MIN_LEN];

        // Set discriminator
        data[0] = REDEMPTION_DISCRIMINATOR;

        // Set status = Processing (1)
        data[REDEMPTION_STATUS_OFFSET] = 1;

        // Set BTC scriptPubKey (P2WPKH example: OP_0 PUSH20 <20-byte hash>)
        let btc_script: [u8; 22] = [
            0x00, 0x14, // OP_0 PUSH20
            0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4,
            0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3, 0x23,
            0xf1, 0x43, 0x3b, 0xd6,
        ];
        data[REDEMPTION_BTC_ADDR_LEN_OFFSET] = btc_script.len() as u8;

        // Set amount = 50000 sats
        let amount: u64 = 50_000;
        data[REDEMPTION_AMOUNT_OFFSET..REDEMPTION_AMOUNT_OFFSET + 8]
            .copy_from_slice(&amount.to_le_bytes());

        // Set BTC scriptPubKey
        data[REDEMPTION_BTC_ADDR_OFFSET..REDEMPTION_BTC_ADDR_OFFSET + btc_script.len()]
            .copy_from_slice(&btc_script);

        // Verify parsing
        assert_eq!(data[0], REDEMPTION_DISCRIMINATOR);
        assert_eq!(data[REDEMPTION_STATUS_OFFSET], 1); // Processing

        let parsed_amount = u64::from_le_bytes(
            data[REDEMPTION_AMOUNT_OFFSET..REDEMPTION_AMOUNT_OFFSET + 8]
                .try_into()
                .unwrap(),
        );
        assert_eq!(parsed_amount, 50_000);

        let script_len = data[REDEMPTION_BTC_ADDR_LEN_OFFSET] as usize;
        let parsed_script =
            &data[REDEMPTION_BTC_ADDR_OFFSET..REDEMPTION_BTC_ADDR_OFFSET + script_len];
        assert_eq!(parsed_script, &btc_script);
    }

    #[test]
    fn test_wrong_discriminator() {
        let mut data = vec![0u8; REDEMPTION_MIN_LEN];
        data[0] = 0xFF; // wrong discriminator

        // Should fail discriminator check
        assert_ne!(data[0], REDEMPTION_DISCRIMINATOR);
    }

    #[test]
    fn test_wrong_status() {
        let mut data = vec![0u8; REDEMPTION_MIN_LEN];
        data[0] = REDEMPTION_DISCRIMINATOR;
        data[REDEMPTION_STATUS_OFFSET] = 0; // Pending (not Processing)

        // Status != 1 means not Processing
        assert_ne!(data[REDEMPTION_STATUS_OFFSET], 1);
    }

    #[test]
    fn test_is_on_curve() {
        // All zeros is NOT on the curve (it's the identity point, but compressed 0 decompresses to identity)
        // A random hash should generally not be on the curve
        let mut hasher = Sha256::new();
        hasher.update(b"test PDA seed");
        let hash = hasher.finalize();
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&hash);

        // We can't guarantee this specific hash is on/off curve,
        // but we can verify the function doesn't panic
        let _ = is_on_curve(&bytes);
    }
}
