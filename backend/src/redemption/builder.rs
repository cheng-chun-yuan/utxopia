//! BTC Transaction Builder
//!
//! Builds unsigned Bitcoin transactions for withdrawals.

use bitcoin::{
    absolute::LockTime,
    transaction::Version,
    Address, Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness,
};
use std::str::FromStr;

use crate::bitcoin::frost_client::SolanaVerification;
use crate::redemption::types::{PoolUtxo, WithdrawalRequest};

/// Minimum output value (dust threshold).
/// Configurable via `DUST_THRESHOLD_SATS` env var — keep low on testnet, raise in production.
fn dust_threshold() -> u64 {
    std::env::var("DUST_THRESHOLD_SATS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(330)
}

/// Builds unsigned BTC transactions
pub struct TxBuilder {
    /// Network (mainnet, testnet, signet)
    network: Network,
    /// Default fee rate (sats/vbyte)
    default_fee_rate: u64,
    /// Base service fee per withdrawal (sats)
    service_fee_base: u64,
    /// Service fee in basis points (0.01% units)
    service_fee_bps: u16,
}

impl TxBuilder {
    /// Create a new transaction builder
    pub fn new(network: Network) -> Self {
        Self {
            network,
            default_fee_rate: 10,
            service_fee_base: 0,
            service_fee_bps: 0,
        }
    }

    /// Create testnet builder
    pub fn new_testnet() -> Self {
        Self::new(Network::Testnet)
    }

    /// Set default fee rate
    pub fn set_fee_rate(&mut self, rate: u64) {
        self.default_fee_rate = rate;
    }

    /// Get current service fee bps
    pub fn service_fee_bps(&self) -> u16 {
        self.service_fee_bps
    }

    /// Get current service fee base
    pub fn service_fee_base(&self) -> u64 {
        self.service_fee_base
    }

    /// Set service fee with percentage + base model
    pub fn set_service_fee_model(&mut self, bps: u16, base: u64) {
        self.service_fee_bps = bps;
        self.service_fee_base = base;
    }

    /// Compute total service fee for a given amount
    fn compute_service_fee(&self, amount: u64) -> u64 {
        let pct_fee = (amount as u128 * self.service_fee_bps as u128 / 10_000) as u64;
        pct_fee.saturating_add(self.service_fee_base)
    }

    /// Build an unsigned withdrawal transaction with UTXO selection and change output.
    pub fn build_withdrawal(
        &self,
        request: &WithdrawalRequest,
        utxos: &[PoolUtxo],
    ) -> Result<UnsignedTx, BuilderError> {
        // Validate destination address
        let dest_address = Address::from_str(&request.btc_address)
            .map_err(|e| BuilderError::InvalidAddress(e.to_string()))?
            .require_network(self.network)
            .map_err(|e| BuilderError::InvalidAddress(e.to_string()))?;

        // Use PDA's locked service_fee if available (source of truth), else compute from pool config
        let service_fee = request.pda_service_fee
            .unwrap_or_else(|| self.compute_service_fee(request.amount_sats));
        let send_amount = request.amount_sats.saturating_sub(service_fee);

        let dust = dust_threshold();
        if send_amount < dust {
            return Err(BuilderError::AmountTooSmall {
                send: send_amount,
                dust,
                request: request.amount_sats,
                service_fee,
                miner_fee: 0,
            });
        }

        // UTXO selection: sort by value descending, pick enough to cover send_amount + miner fee
        let mut sorted_utxos: Vec<&PoolUtxo> = utxos.iter().collect();
        sorted_utxos.sort_by(|a, b| b.amount_sats.cmp(&a.amount_sats));

        let mut selected: Vec<&PoolUtxo> = Vec::new();
        let mut selected_total: u64 = 0;

        for utxo in &sorted_utxos {
            selected.push(utxo);
            selected_total += utxo.amount_sats;

            // Estimate fee with current selection (2 outputs: dest + change)
            let estimated_vsize = 10 + (selected.len() * 58) + 43 + 43;
            let estimated_fee = (estimated_vsize as u64) * self.default_fee_rate;

            if selected_total >= send_amount + estimated_fee {
                break;
            }
        }

        // Final fee calculation with selected UTXOs
        let estimated_vsize = 10 + (selected.len() * 58) + 43 + 43;
        let fee = (estimated_vsize as u64) * self.default_fee_rate;

        if selected_total < send_amount + fee {
            return Err(BuilderError::InsufficientFunds {
                required: send_amount + fee,
                available: selected_total,
            });
        }

        let change_amount = selected_total - send_amount - fee;

        // Build inputs from selected UTXOs
        let inputs: Result<Vec<TxIn>, BuilderError> = selected
            .iter()
            .map(|utxo| {
                let txid = Txid::from_str(&utxo.txid)
                    .map_err(|e| BuilderError::InvalidTxid(e.to_string()))?;

                Ok(TxIn {
                    previous_output: OutPoint {
                        txid,
                        vout: utxo.vout,
                    },
                    script_sig: ScriptBuf::new(),
                    sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                    witness: Witness::new(),
                })
            })
            .collect();

        let inputs = inputs?;

        // Build outputs
        let mut outputs = vec![
            TxOut {
                value: Amount::from_sat(send_amount),
                script_pubkey: dest_address.script_pubkey(),
            },
        ];

        // Add change output back to pool (same address as input)
        if change_amount > dust_threshold() {
            let change_script = hex::decode(&selected[0].script_pubkey)
                .map(ScriptBuf::from_bytes)
                .unwrap_or_else(|_| ScriptBuf::new());
            outputs.push(TxOut {
                value: Amount::from_sat(change_amount),
                script_pubkey: change_script,
            });
        }

        let selected_utxos: Vec<PoolUtxo> = selected.into_iter().cloned().collect();

        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: inputs,
            output: outputs,
        };

        Ok(UnsignedTx {
            tx,
            utxos: selected_utxos,
            fee,
            send_amount,
            service_fee,
            solana_verification: None,
        })
    }

    /// Estimate fee for a withdrawal
    pub fn estimate_fee(&self, num_inputs: usize) -> u64 {
        let estimated_vsize = 10 + (num_inputs * 58) + 43;
        (estimated_vsize as u64) * self.default_fee_rate
    }

    /// Validate a Bitcoin address for this network
    pub fn validate_address(&self, address: &str) -> Result<Address, BuilderError> {
        Address::from_str(address)
            .map_err(|e| BuilderError::InvalidAddress(e.to_string()))?
            .require_network(self.network)
            .map_err(|e| BuilderError::InvalidAddress(e.to_string()))
    }
}

/// Unsigned transaction ready for signing
#[derive(Debug, Clone)]
pub struct UnsignedTx {
    /// The unsigned transaction
    pub tx: Transaction,
    /// UTXOs being spent
    pub utxos: Vec<PoolUtxo>,
    /// Miner fee in satoshis
    pub fee: u64,
    /// Amount being sent to user
    pub send_amount: u64,
    /// Service fee deducted (for logging)
    pub service_fee: u64,
    /// Optional Solana verification data for FROST signers
    pub solana_verification: Option<SolanaVerification>,
}

impl UnsignedTx {
    /// Get transaction ID (will change after signing for segwit)
    pub fn txid(&self) -> String {
        self.tx.compute_txid().to_string()
    }

    /// Get virtual size
    pub fn vsize(&self) -> usize {
        self.tx.vsize()
    }

    /// Serialize for signing
    pub fn serialize(&self) -> Vec<u8> {
        bitcoin::consensus::encode::serialize(&self.tx)
    }
}

/// Builder errors
#[derive(Debug, thiserror::Error)]
pub enum BuilderError {
    #[error("invalid address: {0}")]
    InvalidAddress(String),

    #[error("invalid txid: {0}")]
    InvalidTxid(String),

    #[error("insufficient funds: need {required} sats, have {available} sats")]
    InsufficientFunds { required: u64, available: u64 },

    #[error("no UTXOs provided")]
    NoUtxos,

    #[error("amount too small (send={send} < dust={dust}, request={request}, service_fee={service_fee}, miner_fee={miner_fee})")]
    AmountTooSmall {
        send: u64,
        dust: u64,
        request: u64,
        service_fee: u64,
        miner_fee: u64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fee_estimation() {
        let builder = TxBuilder::new_testnet();

        // 1 input
        let fee1 = builder.estimate_fee(1);
        assert!(fee1 > 0);

        // 2 inputs should be more
        let fee2 = builder.estimate_fee(2);
        assert!(fee2 > fee1);
    }

    #[test]
    fn test_address_validation() {
        let builder = TxBuilder::new_testnet();

        // Valid testnet address
        let result = builder.validate_address("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
        assert!(result.is_ok());

        // Invalid address
        let result = builder.validate_address("invalid");
        assert!(result.is_err());
    }
}
