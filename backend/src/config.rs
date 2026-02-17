//! Environment-based Configuration for zVault Backend
//!
//! This module provides secure configuration loading from environment variables.
//! All sensitive values (keys, secrets) MUST come from environment variables,
//! never from hardcoded values.
//!
//! # Required Environment Variables
//!
//! ## Network Configuration
//! - `ZVAULT_NETWORK` - "mainnet", "testnet", or "devnet" (default: "devnet")
//! - `ZVAULT_SOLANA_RPC` - Solana RPC endpoint URL
//! - `ZVAULT_BITCOIN_RPC` - Bitcoin/Esplora API endpoint URL
//!
//! ## Solana Program IDs (must match deployed contracts)
//! - `ZVAULT_PROGRAM_ID` - zVault program ID
//! - `ZVAULT_POOL_STATE` - Pool state PDA
//! - `ZVAULT_COMMITMENT_TREE` - Commitment tree PDA
//! - `ZVAULT_ZBTC_MINT` - zBTC mint address
//!
//! ## Signing Configuration
//! - `ZVAULT_SIGNING_MODE` - "single" (POC) or "frost" (production)
//! - `ZVAULT_SIGNER_KEY` - Base58-encoded Solana keypair (for relayer)
//! - `ZVAULT_BTC_SIGNER_KEY` - Hex-encoded BTC signing key (single mode only)
//!
//! ## FROST Configuration (production)
//! - `ZVAULT_FROST_THRESHOLD` - Required signers (e.g., "2")
//! - `ZVAULT_FROST_PARTICIPANTS` - Total participants (e.g., "3")
//! - `ZVAULT_FROST_KEY_SHARE` - This node's encrypted key share
//!
//! ## Optional Settings
//! - `ZVAULT_DEPOSIT_LIMIT_SATS` - Maximum deposit per transaction
//! - `ZVAULT_LOG_LEVEL` - Logging level (debug, info, warn, error)
//! - `ZVAULT_DEMO_MODE` - Set to "1" to enable demo instructions (devnet only)

use std::env;
use std::str::FromStr;
use thiserror::Error;

/// Configuration errors
#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing required environment variable: {0}")]
    MissingEnvVar(String),

    #[error("invalid value for {0}: {1}")]
    InvalidValue(String, String),

    #[error("network mismatch: expected {0}, got {1}")]
    NetworkMismatch(String, String),

    #[error("FROST configuration incomplete: {0}")]
    FrostConfigIncomplete(String),

    #[error("demo mode not allowed on {0}")]
    DemoModeNotAllowed(String),
}

/// Network environment
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Mainnet,
    Testnet,
    Devnet,
}

impl FromStr for Network {
    type Err = ConfigError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "mainnet" | "main" => Ok(Network::Mainnet),
            "testnet" | "test" => Ok(Network::Testnet),
            "devnet" | "dev" => Ok(Network::Devnet),
            _ => Err(ConfigError::InvalidValue(
                "ZVAULT_NETWORK".to_string(),
                format!("unknown network: {}", s),
            )),
        }
    }
}

impl Network {
    /// Check if demo mode is allowed on this network
    pub fn allows_demo_mode(&self) -> bool {
        matches!(self, Network::Devnet | Network::Testnet)
    }

    /// Get default Solana RPC for this network
    pub fn default_solana_rpc(&self) -> &'static str {
        match self {
            Network::Mainnet => "https://api.mainnet-beta.solana.com",
            Network::Testnet => "https://api.testnet.solana.com",
            Network::Devnet => "https://api.devnet.solana.com",
        }
    }

    /// Get default Bitcoin/Esplora API for this network
    pub fn default_bitcoin_api(&self) -> &'static str {
        match self {
            Network::Mainnet => "https://blockstream.info/api",
            Network::Testnet => "https://blockstream.info/testnet/api",
            Network::Devnet => "https://blockstream.info/testnet/api",
        }
    }

    /// Get bitcoin network enum
    pub fn bitcoin_network(&self) -> bitcoin::Network {
        match self {
            Network::Mainnet => bitcoin::Network::Bitcoin,
            Network::Testnet | Network::Devnet => bitcoin::Network::Testnet,
        }
    }
}

/// Signing mode configuration
#[derive(Debug, Clone)]
pub enum SigningMode {
    /// Single key signing (POC only, not for production)
    Single {
        /// Hex-encoded private key for BTC signing
        key: String,
    },
    /// FROST threshold signing (production)
    Frost {
        /// Required number of signers
        threshold: u8,
        /// Total number of participants
        participants: u8,
        /// This node's key share (encrypted)
        key_share: String,
    },
}

/// Main configuration struct
#[derive(Debug, Clone)]
pub struct ZVaultConfig {
    /// Network environment
    pub network: Network,

    /// Solana RPC endpoint
    pub solana_rpc: String,

    /// Bitcoin/Esplora API endpoint
    pub bitcoin_api: String,

    /// zVault program ID
    pub program_id: String,

    /// Pool state PDA
    pub pool_state: String,

    /// Commitment tree PDA
    pub commitment_tree: String,

    /// zBTC mint address
    pub zbtc_mint: String,

    /// Signing configuration
    pub signing: SigningMode,

    /// Maximum deposit limit in satoshis
    pub deposit_limit_sats: u64,

    /// Whether demo mode is enabled
    pub demo_mode: bool,

    /// Log level
    pub log_level: String,
}

impl ZVaultConfig {
    /// Load configuration from environment variables
    pub fn from_env() -> Result<Self, ConfigError> {
        // Required: Network
        let network: Network = env::var("ZVAULT_NETWORK")
            .unwrap_or_else(|_| "devnet".to_string())
            .parse()?;

        // RPC endpoints (with defaults)
        let solana_rpc = env::var("ZVAULT_SOLANA_RPC")
            .unwrap_or_else(|_| network.default_solana_rpc().to_string());

        let bitcoin_api = env::var("ZVAULT_BITCOIN_RPC")
            .unwrap_or_else(|_| network.default_bitcoin_api().to_string());

        // Program IDs (required for non-devnet)
        let program_id = get_required_or_devnet_default(
            "ZVAULT_PROGRAM_ID",
            "AtztELZfz3GHA8hFQCv7aT9Mt47Xhknv3ZCNb3fmXsgf",
            network,
        )?;

        let pool_state = get_required_or_devnet_default(
            "ZVAULT_POOL_STATE",
            "8bbcVecB619HHsHn2TQMraJ8R8WjQjApdZY7h9JCJW7b",
            network,
        )?;

        let commitment_tree = get_required_or_devnet_default(
            "ZVAULT_COMMITMENT_TREE",
            "HtfDXZ5mBQNBdZrDxJMbXCDkyUqFdTDj7zAqo3aqrqiA",
            network,
        )?;

        let zbtc_mint = get_required_or_devnet_default(
            "ZVAULT_ZBTC_MINT",
            "HiDyAcEBTS7SRiLA49BZ5B6XMBAksgwLEAHpvteR8vbV",
            network,
        )?;

        // Signing configuration
        let signing = load_signing_config(network)?;

        // Deposit limit (default based on network)
        let default_limit = match network {
            Network::Mainnet => 1_000_000_000, // 10 BTC in sats ($10k at $100k/BTC)
            Network::Testnet => 10_000_000_000, // 100 BTC for testing
            Network::Devnet => 100_000_000_000, // 1000 BTC for development
        };
        let deposit_limit_sats = env::var("ZVAULT_DEPOSIT_LIMIT_SATS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default_limit);

        // Demo mode (only allowed on testnet/devnet)
        let demo_mode = env::var("ZVAULT_DEMO_MODE").map(|v| v == "1").unwrap_or(false);
        if demo_mode && !network.allows_demo_mode() {
            return Err(ConfigError::DemoModeNotAllowed(format!("{:?}", network)));
        }

        let log_level = env::var("ZVAULT_LOG_LEVEL").unwrap_or_else(|_| "info".to_string());

        Ok(Self {
            network,
            solana_rpc,
            bitcoin_api,
            program_id,
            pool_state,
            commitment_tree,
            zbtc_mint,
            signing,
            deposit_limit_sats,
            demo_mode,
            log_level,
        })
    }

    /// Validate configuration for production readiness
    pub fn validate_for_production(&self) -> Result<(), ConfigError> {
        // Must be mainnet
        if self.network != Network::Mainnet {
            return Err(ConfigError::NetworkMismatch(
                "mainnet".to_string(),
                format!("{:?}", self.network),
            ));
        }

        // Must use FROST signing
        if matches!(self.signing, SigningMode::Single { .. }) {
            return Err(ConfigError::FrostConfigIncomplete(
                "single-key signing not allowed for production".to_string(),
            ));
        }

        // Demo mode must be disabled
        if self.demo_mode {
            return Err(ConfigError::DemoModeNotAllowed("mainnet".to_string()));
        }

        Ok(())
    }

    /// Print configuration summary (hiding sensitive values)
    pub fn print_summary(&self) {
        println!("=== zVault Configuration ===");
        println!("Network: {:?}", self.network);
        println!("Solana RPC: {}", self.solana_rpc);
        println!("Bitcoin API: {}", self.bitcoin_api);
        println!("Program ID: {}", self.program_id);
        let signing_mode = match &self.signing {
            SigningMode::Single { .. } => "Single Key (POC)".to_string(),
            SigningMode::Frost { threshold, participants, .. } =>
                format!("FROST {}-of-{}", threshold, participants),
        };
        println!("Signing Mode: {}", signing_mode);
        println!("Deposit Limit: {} sats", self.deposit_limit_sats);
        println!("Demo Mode: {}", self.demo_mode);
        println!("Log Level: {}", self.log_level);
        println!("============================");
    }
}

/// Get required env var, or use default for devnet only
fn get_required_or_devnet_default(
    var_name: &str,
    devnet_default: &str,
    network: Network,
) -> Result<String, ConfigError> {
    match env::var(var_name) {
        Ok(value) => Ok(value),
        Err(_) => {
            if network == Network::Devnet {
                Ok(devnet_default.to_string())
            } else {
                Err(ConfigError::MissingEnvVar(var_name.to_string()))
            }
        }
    }
}

/// Load signing configuration from environment
fn load_signing_config(network: Network) -> Result<SigningMode, ConfigError> {
    let mode = env::var("ZVAULT_SIGNING_MODE").unwrap_or_else(|_| {
        if network == Network::Mainnet {
            "frost".to_string()
        } else {
            "single".to_string()
        }
    });

    match mode.to_lowercase().as_str() {
        "single" => {
            // For devnet, we can use a derived key (with warning)
            let key = env::var("ZVAULT_BTC_SIGNER_KEY").unwrap_or_else(|_| {
                if network == Network::Devnet {
                    eprintln!("WARNING: Using derived POC key for devnet - DO NOT USE WITH REAL FUNDS");
                    // Return empty string to indicate "use derived key"
                    String::new()
                } else {
                    String::new()
                }
            });

            if key.is_empty() && network != Network::Devnet {
                return Err(ConfigError::MissingEnvVar(
                    "ZVAULT_BTC_SIGNER_KEY".to_string(),
                ));
            }

            Ok(SigningMode::Single { key })
        }
        "frost" => {
            let threshold: u8 = env::var("ZVAULT_FROST_THRESHOLD")
                .map_err(|_| {
                    ConfigError::FrostConfigIncomplete("ZVAULT_FROST_THRESHOLD required".to_string())
                })?
                .parse()
                .map_err(|_| {
                    ConfigError::InvalidValue(
                        "ZVAULT_FROST_THRESHOLD".to_string(),
                        "must be a number".to_string(),
                    )
                })?;

            let participants: u8 = env::var("ZVAULT_FROST_PARTICIPANTS")
                .map_err(|_| {
                    ConfigError::FrostConfigIncomplete(
                        "ZVAULT_FROST_PARTICIPANTS required".to_string(),
                    )
                })?
                .parse()
                .map_err(|_| {
                    ConfigError::InvalidValue(
                        "ZVAULT_FROST_PARTICIPANTS".to_string(),
                        "must be a number".to_string(),
                    )
                })?;

            let key_share = env::var("ZVAULT_FROST_KEY_SHARE").map_err(|_| {
                ConfigError::FrostConfigIncomplete("ZVAULT_FROST_KEY_SHARE required".to_string())
            })?;

            if threshold > participants {
                return Err(ConfigError::InvalidValue(
                    "ZVAULT_FROST_THRESHOLD".to_string(),
                    "threshold cannot exceed participants".to_string(),
                ));
            }

            Ok(SigningMode::Frost {
                threshold,
                participants,
                key_share,
            })
        }
        _ => Err(ConfigError::InvalidValue(
            "ZVAULT_SIGNING_MODE".to_string(),
            format!("unknown mode: {} (use 'single' or 'frost')", mode),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_network_parsing() {
        assert!(matches!("mainnet".parse::<Network>(), Ok(Network::Mainnet)));
        assert!(matches!("testnet".parse::<Network>(), Ok(Network::Testnet)));
        assert!(matches!("devnet".parse::<Network>(), Ok(Network::Devnet)));
        assert!("invalid".parse::<Network>().is_err());
    }

    #[test]
    fn test_demo_mode_restrictions() {
        assert!(Network::Devnet.allows_demo_mode());
        assert!(Network::Testnet.allows_demo_mode());
        assert!(!Network::Mainnet.allows_demo_mode());
    }
}
