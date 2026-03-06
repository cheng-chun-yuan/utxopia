//! Redemption PDA Scanner
//!
//! Scans Solana for RedemptionRequest PDAs and returns parsed state.

use crate::redemption::types::ParsedRedemption;
use crate::solana::client::SolClient;

/// Scans Solana for on-chain RedemptionRequest PDAs
pub struct RedemptionScanner {
    sol_client: SolClient,
}

impl RedemptionScanner {
    /// Create a new scanner with the given Solana client
    pub fn new(sol_client: SolClient) -> Self {
        Self { sol_client }
    }

    /// Scan all RedemptionRequest PDAs, group by status
    pub fn scan(&self) -> Result<ScanResult, ScannerError> {
        let all = self
            .sol_client
            .fetch_redemption_pdas()
            .map_err(|e| ScannerError::RpcError(e.to_string()))?;

        let mut pending = Vec::new();
        let mut processing = Vec::new();
        let mut failed = Vec::new();

        for r in all {
            match r.status {
                0 => pending.push(r),
                1 => processing.push(r),
                2 => failed.push(r),
                _ => {
                    // Unknown status — treat as parse error but skip silently
                    tracing::warn!(
                        status = r.status,
                        pda = %r.pda_address,
                        "Unknown redemption status"
                    );
                }
            }
        }

        Ok(ScanResult {
            pending,
            processing,
            failed,
        })
    }

    /// Check connection to Solana
    pub fn is_connected(&self) -> bool {
        self.sol_client.is_connected()
    }

    /// Access the underlying Solana client
    pub fn sol_client(&self) -> &SolClient {
        &self.sol_client
    }
}

/// Result of a redemption PDA scan, grouped by status
pub struct ScanResult {
    /// Status 0: pending redemptions waiting to be picked up
    pub pending: Vec<ParsedRedemption>,
    /// Status 1: redemptions currently being processed
    pub processing: Vec<ParsedRedemption>,
    /// Status 2: failed redemptions eligible for retry
    pub failed: Vec<ParsedRedemption>,
}

impl ScanResult {
    /// Total number of redemption PDAs found
    pub fn total(&self) -> usize {
        self.pending.len() + self.processing.len() + self.failed.len()
    }

    /// Collect all PDA addresses (useful for reconciliation)
    pub fn all_addresses(&self) -> Vec<String> {
        self.pending
            .iter()
            .chain(self.processing.iter())
            .chain(self.failed.iter())
            .map(|r| r.pda_address.clone())
            .collect()
    }
}

/// Scanner errors
#[derive(Debug, thiserror::Error)]
pub enum ScannerError {
    #[error("RPC error: {0}")]
    RpcError(String),

    #[error("parse error: {0}")]
    ParseError(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_result_total() {
        let result = ScanResult {
            pending: vec![],
            processing: vec![],
            failed: vec![],
        };
        assert_eq!(result.total(), 0);
    }

    #[test]
    fn test_scan_result_all_addresses() {
        let make = |addr: &str| ParsedRedemption {
            pda_address: addr.to_string(),
            status: 0,
            requester: String::new(),
            amount_sats: 0,
            btc_script: vec![],
            request_id: 0,
            processing_slot: 0,
        };

        let result = ScanResult {
            pending: vec![make("aaa")],
            processing: vec![make("bbb")],
            failed: vec![make("ccc"), make("ddd")],
        };
        assert_eq!(result.total(), 4);
        let addrs = result.all_addresses();
        assert_eq!(addrs, vec!["aaa", "bbb", "ccc", "ddd"]);
    }
}
