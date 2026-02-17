//! BTC Transaction Builder
//!
//! Builds unsigned Bitcoin transactions for withdrawals.

use bitcoin::{
    absolute::LockTime,
    transaction::Version,
    Address, Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness,
};
use std::str::FromStr;

use crate::redemption::types::{PoolUtxo, WithdrawalRequest};

/// Builds unsigned BTC transactions
pub struct TxBuilder {
    /// Network (mainnet, testnet, signet)
    network: Network,
    /// Default fee rate (sats/vbyte)
    default_fee_rate: u64,
}

impl TxBuilder {
    /// Create a new transaction builder
    pub fn new(network: Network) -> Self {
        Self {
            network,
            default_fee_rate: 10,
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

    /// Build an unsigned withdrawal transaction
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

        // Calculate total input value
        let total_input: u64 = utxos.iter().map(|u| u.amount_sats).sum();

        // Estimate transaction size for fee calculation
        // P2TR input: ~58 vbytes, P2TR output: ~43 vbytes
        let estimated_vsize = 10 + (utxos.len() * 58) + 43 + 43; // 2 outputs (dest + change)
        let fee = (estimated_vsize as u64) * self.default_fee_rate;

        // Calculate amounts
        let send_amount = request.net_amount();
        let change_amount = total_input.saturating_sub(send_amount).saturating_sub(fee);

        if total_input < send_amount + fee {
            return Err(BuilderError::InsufficientFunds {
                required: send_amount + fee,
                available: total_input,
            });
        }

        // Build inputs
        let inputs: Result<Vec<TxIn>, BuilderError> = utxos
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
        let outputs = vec![
            // Destination output
            TxOut {
                value: Amount::from_sat(send_amount),
                script_pubkey: dest_address.script_pubkey(),
            },
        ];

        // Add change output if significant
        if change_amount > 546 {
            // Dust threshold
            // For POC, we'll need a change address from the pool
            // For now, we'll skip change (send all to destination)
            // In production, this would go back to pool
        }

        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: inputs,
            output: outputs,
        };

        Ok(UnsignedTx {
            tx,
            utxos: utxos.to_vec(),
            fee,
            send_amount,
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
    /// Fee in satoshis
    pub fee: u64,
    /// Amount being sent
    pub send_amount: u64,
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

    #[error("amount too small")]
    AmountTooSmall,
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
