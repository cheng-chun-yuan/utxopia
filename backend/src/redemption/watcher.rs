//! Solana Burn Event Watcher
//!
//! Watches Solana for zBTC burn events.

use crate::redemption::types::BurnEvent;
use crate::sol_client::{SolClient, SolConfig};

/// Watches Solana for burn events
pub struct BurnWatcher {
    /// Solana client
    sol_client: SolClient,
    /// Program ID to watch
    _program_id: String,
    /// Last processed slot
    last_slot: u64,
}

impl BurnWatcher {
    /// Create a new burn watcher
    pub fn new(sol_config: SolConfig, program_id: String) -> Self {
        Self {
            sol_client: SolClient::new(sol_config),
            _program_id: program_id,
            last_slot: 0,
        }
    }

    /// Create for devnet with default program
    pub fn new_devnet() -> Self {
        Self::new(
            SolConfig::default(),
            "StBrdg1111111111111111111111111111111111111".to_string(),
        )
    }

    /// Check for new burn events
    pub async fn check_burns(&mut self) -> Result<Vec<BurnEvent>, WatcherError> {
        // For POC: Simulate burn event detection
        // In production, this would:
        // 1. Query Solana for recent transactions to the program
        // 2. Parse transaction logs for burn events
        // 3. Extract burn details (amount, user, btc_address)

        // Get current slot
        let current_slot = self
            .sol_client
            .get_slot()
            .map_err(|e| WatcherError::SolanaError(e.to_string()))?;

        // Update last processed slot
        self.last_slot = current_slot;

        // Return empty for now (simulation)
        Ok(vec![])
    }

    /// Parse a burn event from transaction logs (placeholder)
    #[allow(dead_code)]
    fn parse_burn_event(&self, _logs: &[String]) -> Option<BurnEvent> {
        // In production:
        // - Parse "Program log: Burn zBTC: amount=X, address=Y"
        // - Extract structured data
        None
    }

    /// Get last processed slot
    pub fn last_slot(&self) -> u64 {
        self.last_slot
    }

    /// Manually add a burn event (for testing/manual processing)
    pub fn create_manual_burn(
        &self,
        signature: String,
        user: String,
        amount: u64,
        btc_address: String,
    ) -> BurnEvent {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        BurnEvent {
            signature,
            user,
            amount,
            btc_address,
            slot: self.last_slot,
            timestamp: now,
        }
    }

    /// Check connection to Solana
    pub fn is_connected(&self) -> bool {
        self.sol_client.is_connected()
    }
}

/// Watcher errors
#[derive(Debug, thiserror::Error)]
pub enum WatcherError {
    #[error("solana error: {0}")]
    SolanaError(String),

    #[error("parse error: {0}")]
    ParseError(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manual_burn_creation() {
        let watcher = BurnWatcher::new_devnet();

        let burn = watcher.create_manual_burn(
            "sig123".to_string(),
            "user_pubkey".to_string(),
            100_000,
            "tb1qtest".to_string(),
        );

        assert_eq!(burn.amount, 100_000);
        assert_eq!(burn.btc_address, "tb1qtest");
    }
}
