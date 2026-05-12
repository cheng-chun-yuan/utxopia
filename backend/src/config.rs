//! Environment-based Configuration for UTXOpia Backend
//!
//! This module provides secure configuration loading from environment variables.
//! All sensitive values (keys, secrets) MUST come from environment variables,
//! never from hardcoded values.
//!
//! # Required Environment Variables
//!
//! ## Network Configuration
//! - `UTXOPIA_NETWORK` - "mainnet", "testnet", or "devnet" (default: "devnet")
//! - `UTXOPIA_SOLANA_RPC` - Solana RPC endpoint URL
//! - `UTXOPIA_BITCOIN_RPC` - Bitcoin/Esplora API endpoint URL
//!
//! ## Solana Program IDs (must match deployed contracts)
//! - `UTXOPIA_PROGRAM_ID` - UTXOpia program ID
//! - `UTXOPIA_POOL_STATE` - Pool state PDA
//! - `UTXOPIA_COMMITMENT_TREE` - Commitment tree PDA
//! - `UTXOPIA_ZKBTC_MINT` - zkBTC mint address
//!
//! ## Signing Configuration
//! - `UTXOPIA_SIGNING_MODE` - "single" (POC) or "frost" (production)
//! - `UTXOPIA_SIGNER_KEY` - Base58-encoded Solana keypair (for relayer)
//! - `UTXOPIA_BTC_SIGNER_KEY` - Hex-encoded BTC signing key (single mode only)
//!
//! ## FROST Configuration (production)
//! - `UTXOPIA_FROST_THRESHOLD` - Required signers (e.g., "2")
//! - `UTXOPIA_FROST_PARTICIPANTS` - Total participants (e.g., "3")
//! - `UTXOPIA_FROST_KEY_SHARE` - This node's encrypted key share
//!
//! ## Optional Settings
//! - `UTXOPIA_DEPOSIT_LIMIT_SATS` - Maximum deposit per transaction
//! - `UTXOPIA_LOG_LEVEL` - Logging level (debug, info, warn, error)
//! - `UTXOPIA_DEMO_MODE` - Set to "1" to enable demo instructions (devnet only)

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
    Regtest,
}

impl FromStr for Network {
    type Err = ConfigError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "mainnet" | "main" => Ok(Network::Mainnet),
            "testnet" | "test" => Ok(Network::Testnet),
            "devnet" | "dev" | "testnet4" => Ok(Network::Devnet),
            "regtest" | "localnet" | "local" => Ok(Network::Regtest),
            _ => Err(ConfigError::InvalidValue(
                "UTXOPIA_NETWORK".to_string(),
                format!("unknown network: {}", s),
            )),
        }
    }
}

impl Network {
    /// Check if demo mode is allowed on this network
    pub fn allows_demo_mode(&self) -> bool {
        matches!(self, Network::Devnet | Network::Testnet | Network::Regtest)
    }

    /// Get default Solana RPC for this network
    pub fn default_solana_rpc(&self) -> &'static str {
        match self {
            Network::Mainnet => "https://api.mainnet-beta.solana.com",
            Network::Testnet => "https://api.testnet.solana.com",
            Network::Devnet => "https://api.devnet.solana.com",
            Network::Regtest => "http://127.0.0.1:8899",
        }
    }

    /// Get default Bitcoin/Esplora API for this network (mempool.space).
    /// Respects UTXOPIA_BITCOIN_NETWORK env var to override (e.g., "testnet" or "testnet4").
    pub fn default_bitcoin_api(&self) -> String {
        // Allow explicit override via UTXOPIA_BITCOIN_NETWORK
        if let Ok(btc_net) = env::var("UTXOPIA_BITCOIN_NETWORK") {
            return match btc_net.as_str() {
                "mainnet" => "https://mempool.space/api".to_string(),
                "testnet" | "testnet3" => "https://mempool.space/testnet/api".to_string(),
                "testnet4" => "https://mempool.space/testnet4/api".to_string(),
                "signet" => "https://mempool.space/signet/api".to_string(),
                _ => format!("https://mempool.space/{}/api", btc_net),
            };
        }
        match self {
            Network::Mainnet => "https://mempool.space/api".to_string(),
            Network::Testnet => "https://mempool.space/testnet/api".to_string(),
            Network::Devnet => "https://mempool.space/testnet/api".to_string(),
            Network::Regtest => "http://localhost:3002/regtest/api".to_string(),
        }
    }

    /// Get bitcoin network enum
    pub fn bitcoin_network(&self) -> bitcoin::Network {
        match self {
            Network::Mainnet => bitcoin::Network::Bitcoin,
            Network::Testnet | Network::Devnet => bitcoin::Network::Testnet,
            Network::Regtest => bitcoin::Network::Regtest,
        }
    }
}

/// Signing mode configuration
#[derive(Debug, Clone)]
pub enum SigningMode {
    /// Single key signing (POC / tests only, not for production)
    Single {
        /// Hex-encoded private key for BTC signing
        key: String,
    },
    /// FROST threshold signing (legacy — being decommissioned in favor of Ika)
    Frost {
        /// Required number of signers
        threshold: u8,
        /// Total number of participants
        participants: u8,
        /// This node's key share (encrypted)
        key_share: String,
        /// URLs of FROST signer servers (e.g., ["http://localhost:4001", ...])
        signer_urls: Vec<String>,
        /// Optional API key for authenticating with FROST servers
        api_key: Option<String>,
    },
    /// Ika dWallet (Solana-native, 2PC-MPC). Replaces FROST in v2.
    Ika {
        /// Ika dWallet program ID (devnet: 87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY).
        program_id: String,
        /// dWallet account address (Solana pubkey, base58).
        dwallet: String,
        /// dWallet's compressed-x x-only secp256k1 pubkey (hex, 32 bytes).
        dwallet_xonly_pubkey: String,
        /// gRPC endpoint for the off-chain mock signer (pre-alpha).
        grpc_endpoint: String,
    },
}

impl SigningMode {
    /// Create a FrostClient from FROST signing config.
    /// Returns None for any non-Frost mode.
    pub fn frost_client(&self) -> Option<crate::bitcoin::frost_client::FrostClient> {
        match self {
            SigningMode::Frost { threshold, signer_urls, api_key, .. } => {
                Some(crate::bitcoin::frost_client::FrostClient::new(
                    signer_urls.clone(),
                    *threshold as usize,
                    api_key.clone(),
                ))
            }
            _ => None,
        }
    }

    /// Get the FROST group public key from the signer's /info endpoint.
    /// Returns None for any non-Frost mode.
    pub fn frost_signer_urls(&self) -> Option<&[String]> {
        match self {
            SigningMode::Frost { signer_urls, .. } => Some(signer_urls),
            _ => None,
        }
    }

    /// True if this is an Ika dWallet signing config.
    pub fn is_ika(&self) -> bool {
        matches!(self, SigningMode::Ika { .. })
    }

    /// True if this is a FROST signing config.
    pub fn is_frost(&self) -> bool {
        matches!(self, SigningMode::Frost { .. })
    }
}

/// Main configuration struct
#[derive(Debug, Clone)]
pub struct UTXOpiaConfig {
    /// Network environment
    pub network: Network,

    /// Solana RPC endpoint
    pub solana_rpc: String,

    /// Bitcoin/Esplora API endpoint
    pub bitcoin_api: String,

    /// UTXOpia program ID
    pub program_id: String,

    /// Pool state PDA
    pub pool_state: String,

    /// Commitment tree PDA
    pub commitment_tree: String,

    /// zkBTC mint address
    pub zkbtc_mint: String,

    /// Signing configuration
    pub signing: SigningMode,

    /// Maximum deposit limit in satoshis
    pub deposit_limit_sats: u64,

    /// Whether demo mode is enabled
    pub demo_mode: bool,

    /// Log level
    pub log_level: String,
}

impl UTXOpiaConfig {
    /// Load configuration from environment variables
    pub fn from_env() -> Result<Self, ConfigError> {
        // Required: Network
        let network: Network = env::var("UTXOPIA_NETWORK")
            .unwrap_or_else(|_| "devnet".to_string())
            .parse()?;

        // RPC endpoints (with defaults)
        let solana_rpc = env::var("UTXOPIA_SOLANA_RPC")
            .unwrap_or_else(|_| network.default_solana_rpc().to_string());

        let bitcoin_api = env::var("UTXOPIA_BITCOIN_RPC")
            .unwrap_or_else(|_| network.default_bitcoin_api().to_string());

        // Program IDs (required for non-devnet)
        let program_id = get_required_or_devnet_default(
            "UTXOPIA_PROGRAM_ID",
            "7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ",
            network,
        )?;

        // Derive PDAs from program ID (deterministic)
        let program_pubkey: solana_sdk::pubkey::Pubkey = program_id.parse()
            .map_err(|_| ConfigError::MissingEnvVar("UTXOPIA_PROGRAM_ID (invalid pubkey)".into()))?;
        let (pool_state_pubkey, _) = solana_sdk::pubkey::Pubkey::find_program_address(
            &[b"pool_state"], &program_pubkey,
        );
        let (commitment_tree_pubkey, _) = solana_sdk::pubkey::Pubkey::find_program_address(
            &[b"commitment_tree"], &program_pubkey,
        );
        let pool_state = pool_state_pubkey.to_string();
        let commitment_tree = commitment_tree_pubkey.to_string();

        let zkbtc_mint = get_required_or_devnet_default(
            "UTXOPIA_ZKBTC_MINT",
            "G5CHaLkWjdUxxmnrVqNLQ29K7PoNwJAzvVT11jjkdGKC",
            network,
        )?;

        // Signing configuration
        let signing = load_signing_config(network)?;

        // Deposit limit (default based on network)
        let default_limit = match network {
            Network::Mainnet => 1_000_000_000, // 10 BTC in sats ($10k at $100k/BTC)
            Network::Testnet => 10_000_000_000, // 100 BTC for testing
            Network::Devnet | Network::Regtest => 100_000_000_000, // 1000 BTC for development
        };
        let deposit_limit_sats = env::var("UTXOPIA_DEPOSIT_LIMIT_SATS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default_limit);

        // Demo mode (only allowed on testnet/devnet)
        let demo_mode = env::var("UTXOPIA_DEMO_MODE").map(|v| v == "1").unwrap_or(false);
        if demo_mode && !network.allows_demo_mode() {
            return Err(ConfigError::DemoModeNotAllowed(format!("{:?}", network)));
        }

        let log_level = env::var("UTXOPIA_LOG_LEVEL").unwrap_or_else(|_| "info".to_string());

        Ok(Self {
            network,
            solana_rpc,
            bitcoin_api,
            program_id,
            pool_state,
            commitment_tree,
            zkbtc_mint,
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
        println!("=== UTXOpia Configuration ===");
        println!("Network: {:?}", self.network);
        println!("Solana RPC: {}", self.solana_rpc);
        println!("Bitcoin API: {}", self.bitcoin_api);
        println!("Program ID: {}", self.program_id);
        let signing_mode = match &self.signing {
            SigningMode::Single { .. } => "Single Key (POC)".to_string(),
            SigningMode::Frost { threshold, participants, signer_urls, .. } =>
                format!("FROST {}-of-{} ({} signer URLs)", threshold, participants, signer_urls.len()),
            SigningMode::Ika { dwallet, .. } => format!("Ika dWallet ({})", &dwallet[..16.min(dwallet.len())]),
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
            if matches!(network, Network::Devnet | Network::Regtest) {
                Ok(devnet_default.to_string())
            } else {
                Err(ConfigError::MissingEnvVar(var_name.to_string()))
            }
        }
    }
}

/// Load signing configuration from environment
fn load_signing_config(network: Network) -> Result<SigningMode, ConfigError> {
    let mode = env::var("UTXOPIA_SIGNING_MODE").unwrap_or_else(|_| {
        if matches!(network, Network::Mainnet) {
            "frost".to_string()
        } else {
            "single".to_string()
        }
    });

    match mode.to_lowercase().as_str() {
        "single" => {
            // For devnet, we can use a derived key (with warning)
            let key = env::var("UTXOPIA_BTC_SIGNER_KEY").unwrap_or_else(|_| {
                if matches!(network, Network::Devnet | Network::Regtest) {
                    eprintln!("WARNING: Using derived POC key for devnet/regtest - DO NOT USE WITH REAL FUNDS");
                    // Return empty string to indicate "use derived key"
                    String::new()
                } else {
                    String::new()
                }
            });

            if key.is_empty() && !matches!(network, Network::Devnet | Network::Regtest) {
                return Err(ConfigError::MissingEnvVar(
                    "UTXOPIA_BTC_SIGNER_KEY".to_string(),
                ));
            }

            Ok(SigningMode::Single { key })
        }
        "frost" => {
            let threshold: u8 = env::var("UTXOPIA_FROST_THRESHOLD")
                .map_err(|_| {
                    ConfigError::FrostConfigIncomplete("UTXOPIA_FROST_THRESHOLD required".to_string())
                })?
                .parse()
                .map_err(|_| {
                    ConfigError::InvalidValue(
                        "UTXOPIA_FROST_THRESHOLD".to_string(),
                        "must be a number".to_string(),
                    )
                })?;

            let participants: u8 = env::var("UTXOPIA_FROST_PARTICIPANTS")
                .map_err(|_| {
                    ConfigError::FrostConfigIncomplete(
                        "UTXOPIA_FROST_PARTICIPANTS required".to_string(),
                    )
                })?
                .parse()
                .map_err(|_| {
                    ConfigError::InvalidValue(
                        "UTXOPIA_FROST_PARTICIPANTS".to_string(),
                        "must be a number".to_string(),
                    )
                })?;

            let key_share = env::var("UTXOPIA_FROST_KEY_SHARE").map_err(|_| {
                ConfigError::FrostConfigIncomplete("UTXOPIA_FROST_KEY_SHARE required".to_string())
            })?;

            if threshold > participants {
                return Err(ConfigError::InvalidValue(
                    "UTXOPIA_FROST_THRESHOLD".to_string(),
                    "threshold cannot exceed participants".to_string(),
                ));
            }

            let signer_urls: Vec<String> = env::var("UTXOPIA_FROST_SIGNER_URLS")
                .map_err(|_| {
                    ConfigError::FrostConfigIncomplete(
                        "UTXOPIA_FROST_SIGNER_URLS required (comma-separated URLs)".to_string(),
                    )
                })?
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();

            if signer_urls.len() < participants as usize {
                return Err(ConfigError::FrostConfigIncomplete(format!(
                    "UTXOPIA_FROST_SIGNER_URLS has {} URLs but {} participants configured",
                    signer_urls.len(),
                    participants,
                )));
            }

            let api_key = env::var("UTXOPIA_FROST_API_KEY").ok();

            Ok(SigningMode::Frost {
                threshold,
                participants,
                key_share,
                signer_urls,
                api_key,
            })
        }
        "ika" => {
            // Ika dWallet — Solana-native pre-alpha. All four UTXOPIA_IKA_* vars
            // are sync-env.sh-generated; missing values mean the state JSON's "ika"
            // block hasn't been populated by the DKG one-shot setup yet.
            let program_id = env::var("UTXOPIA_IKA_PROGRAM_ID").map_err(|_| {
                ConfigError::FrostConfigIncomplete(
                    "UTXOPIA_IKA_PROGRAM_ID required (run scripts/ika-setup/ to populate)"
                        .to_string(),
                )
            })?;
            let dwallet = env::var("UTXOPIA_IKA_DWALLET").map_err(|_| {
                ConfigError::FrostConfigIncomplete(
                    "UTXOPIA_IKA_DWALLET required (run scripts/ika-setup/ to populate)"
                        .to_string(),
                )
            })?;
            let dwallet_xonly_pubkey =
                env::var("UTXOPIA_IKA_DWALLET_XONLY_PUBKEY").map_err(|_| {
                    ConfigError::FrostConfigIncomplete(
                        "UTXOPIA_IKA_DWALLET_XONLY_PUBKEY required \
                         (run scripts/ika-setup/ to populate)"
                            .to_string(),
                    )
                })?;
            let grpc_endpoint = env::var("UTXOPIA_IKA_GRPC_ENDPOINT").unwrap_or_else(
                |_| "pre-alpha-dev-1.ika.ika-network.net:443".to_string(),
            );

            Ok(SigningMode::Ika {
                program_id,
                dwallet,
                dwallet_xonly_pubkey,
                grpc_endpoint,
            })
        }
        _ => Err(ConfigError::InvalidValue(
            "UTXOPIA_SIGNING_MODE".to_string(),
            format!("unknown mode: {} (use 'single', 'frost', or 'ika')", mode),
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
