//! zBTC Backend - Minimal Services
//!
//! Server-side services:
//! 1. Header Relay (TypeScript) - Submits Bitcoin headers to Solana light client
//! 2. Redemption Processor - Processes BTC withdrawals
//! 3. Deposit Tracker - Tracks BTC deposits and handles SPV verification
//!
//! All other functionality is handled by the SDK on the client side.
//!
//! Run modes:
//!   cargo run                    - Show usage
//!   cargo run -- api             - Start REST API (for frontend)
//!   cargo run -- redemption      - Start redemption processor (background)
//!   cargo run -- tracker         - Start deposit tracker (background)
//!   cargo run -- demo            - Run interactive demo

use zbtc::api_server as api;
use zbtc::config::ZVaultConfig;
use zbtc::deposit_tracker::{self, TrackerConfig};
use zbtc::redemption::{MpcSigner, RedemptionConfig, RedemptionService, SingleKeySigner};
use zbtc::stealth::StealthDepositService;
use zbtc::units;
use std::env;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        print_usage();
        return;
    }

    match args[1].as_str() {
        "api" => run_api_server(&args[2..]).await,
        "redemption" => run_redemption_service(&args[2..]).await,
        "tracker" => run_tracker_service(&args[2..]).await,
        "demo" => run_demo().await,
        "help" | "--help" | "-h" => print_usage(),
        _ => print_usage(),
    }
}

fn print_usage() {
    println!("zBTC Backend - Server-Side Services");
    println!();
    println!("Usage:");
    println!("  zbtc-api api [--port <port>]               Start REST API server (default: 3001)");
    println!("  zbtc-api redemption [--interval <secs>]    Start redemption processor");
    println!("  zbtc-api tracker [options]                 Start deposit tracker");
    println!("  zbtc-api demo                              Run interactive demo");
    println!();
    println!("Tracker Options:");
    println!("  --interval <secs>       Poll interval (default: 30)");
    println!("  --confirmations <n>     Required BTC confirmations (default: 3)");
    println!("  --db-path <path>        SQLite database path (default: data/deposits.db)");
    println!("  --max-retries <n>       Max retry attempts for failed operations (default: 5)");
    println!();
    println!("Environment Variables:");
    println!("  POOL_SIGNING_KEY              Hex-encoded private key for BTC signing");
    println!("  POOL_RECEIVE_ADDRESS          Pool wallet address for swept funds");
    println!("  API_PORT                      REST API port (default: 3001)");
    println!("  SOLANA_RPC_URL                Solana RPC endpoint");
    println!("  VERIFIER_KEYPAIR              Path to Solana keypair for verification");
    println!("  DEPOSIT_DB_PATH               SQLite database path");
    println!("  DEPOSIT_POLL_INTERVAL_SECS    Poll interval in seconds");
    println!("  DEPOSIT_REQUIRED_CONFIRMATIONS Required BTC confirmations");
    println!("  DEPOSIT_MAX_RETRIES           Max retry attempts");
    println!();
    println!("Note: Most functionality is handled by the SDK on the client side.");
    println!();
    println!("Header Relay (TypeScript):");
    println!("  cd backend/header-relayer && bun run start");
}

/// Create redemption service from environment, supporting both single-key and FROST modes
fn create_service(config: RedemptionConfig) -> RedemptionService {
    // Check for FROST signing mode first
    if let Ok(mode) = env::var("ZVAULT_SIGNING_MODE") {
        if mode.to_lowercase() == "frost" {
            return match create_frost_service(config.clone()) {
                Ok(service) => service,
                Err(e) => {
                    eprintln!("Warning: Failed to configure FROST signing: {}", e);
                    eprintln!("Falling back to testnet single-key signer");
                    RedemptionService::new_testnet()
                }
            };
        }
    }

    // Single-key mode
    if let Ok(key_hex) = env::var("POOL_SIGNING_KEY") {
        match SingleKeySigner::from_hex(&key_hex) {
            Ok(signer) => RedemptionService::new_with_signer(config, signer),
            Err(e) => {
                eprintln!("Warning: Invalid POOL_SIGNING_KEY: {}", e);
                RedemptionService::new_testnet()
            }
        }
    } else {
        RedemptionService::new_testnet()
    }
}

/// Create redemption service with FROST threshold signing
fn create_frost_service(config: RedemptionConfig) -> Result<RedemptionService, String> {
    let zvault_config = ZVaultConfig::from_env().map_err(|e| e.to_string())?;

    let frost_client = zvault_config
        .signing
        .frost_client()
        .ok_or("signing mode is not FROST")?;

    // Get group pubkey from ZVAULT_FROST_GROUP_PUBKEY env var
    let group_pubkey_hex = env::var("ZVAULT_FROST_GROUP_PUBKEY")
        .map_err(|_| "ZVAULT_FROST_GROUP_PUBKEY required for FROST mode".to_string())?;

    let group_pubkey_bytes = hex::decode(&group_pubkey_hex)
        .map_err(|e| format!("invalid group pubkey hex: {}", e))?;

    let group_pubkey = bitcoin::XOnlyPublicKey::from_slice(&group_pubkey_bytes)
        .map_err(|e| format!("invalid group pubkey: {}", e))?;

    let signer = MpcSigner::new(frost_client, group_pubkey);
    Ok(RedemptionService::new_with_signer(config, signer))
}

async fn run_api_server(args: &[String]) {
    let mut port: u16 = env::var("API_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3001);

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" if i + 1 < args.len() => {
                port = args[i + 1].parse().unwrap_or(3001);
                i += 2;
            }
            _ => i += 1,
        }
    }

    let config = RedemptionConfig::default();
    let redemption = create_service(config);
    let stealth = StealthDepositService::new_testnet();

    if let Err(e) = api::start_combined_server(redemption, stealth, port).await {
        eprintln!("API server error: {}", e);
    }
}

async fn run_redemption_service(args: &[String]) {
    let mut config = RedemptionConfig::default();

    // Parse arguments
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--interval" if i + 1 < args.len() => {
                config.check_interval_secs = args[i + 1].parse().unwrap_or(30);
                i += 2;
            }
            "--min-amount" if i + 1 < args.len() => {
                config.min_withdrawal = args[i + 1].parse().unwrap_or(10_000);
                i += 2;
            }
            _ => i += 1,
        }
    }

    let service = create_service(config.clone());

    println!("=== zBTC Redemption Processor ===");
    println!();
    println!("Configuration:");
    println!("  Check Interval: {} seconds", config.check_interval_secs);
    println!("  Min Withdrawal: {}", units::format_sats(config.min_withdrawal));
    println!("  Max Withdrawal: {}", units::format_sats(config.max_withdrawal));
    println!();
    println!("Signer: {} ({})", service.signer_type(), service.pool_public_key());
    println!();
    println!("Watching for RedemptionRequest PDAs on Solana...");
    println!("Press Ctrl+C to stop");
    println!();

    if let Err(e) = service.run().await {
        eprintln!("Error: {}", e);
    }
}

async fn run_tracker_service(args: &[String]) {
    let mut config = TrackerConfig::default();

    // Parse arguments
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--interval" if i + 1 < args.len() => {
                config.poll_interval_secs = args[i + 1].parse().unwrap_or(30);
                i += 2;
            }
            "--confirmations" if i + 1 < args.len() => {
                config.required_confirmations = args[i + 1].parse().unwrap_or(3);
                i += 2;
            }
            "--db-path" if i + 1 < args.len() => {
                config.db_path = args[i + 1].clone();
                i += 2;
            }
            "--max-retries" if i + 1 < args.len() => {
                config.max_retries = args[i + 1].parse().unwrap_or(5);
                i += 2;
            }
            _ => i += 1,
        }
    }

    // Load config from environment
    if let Ok(addr) = env::var("POOL_RECEIVE_ADDRESS") {
        config.pool_receive_address = addr;
    }
    if let Ok(rpc) = env::var("SOLANA_RPC_URL") {
        config.solana_rpc = rpc;
    }
    if let Ok(db_path) = env::var("DEPOSIT_DB_PATH") {
        config.db_path = db_path;
    }
    if let Ok(interval) = env::var("DEPOSIT_POLL_INTERVAL_SECS") {
        config.poll_interval_secs = interval.parse().unwrap_or(30);
    }
    if let Ok(confirmations) = env::var("DEPOSIT_REQUIRED_CONFIRMATIONS") {
        config.required_confirmations = confirmations.parse().unwrap_or(3);
    }
    if let Ok(max_retries) = env::var("DEPOSIT_MAX_RETRIES") {
        config.max_retries = max_retries.parse().unwrap_or(5);
    }

    // Create data directory if using default path
    if config.db_path.starts_with("data/") {
        if let Err(e) = std::fs::create_dir_all("data") {
            eprintln!("Warning: Failed to create data directory: {}", e);
        }
    }

    // Create service with optional sweeper
    let service = deposit_tracker::DepositTrackerService::new_testnet(config.clone());

    // Configure sweeper based on signing mode
    let service = if let Ok(mode) = env::var("ZVAULT_SIGNING_MODE") {
        if mode.to_lowercase() == "frost" {
            // FROST threshold signing
            match configure_frost_sweeper(service, &config) {
                Ok(s) => {
                    println!("Sweeper configured with FROST threshold signing");
                    s
                }
                Err(e) => {
                    eprintln!("Warning: Failed to configure FROST sweeper: {}", e);
                    deposit_tracker::DepositTrackerService::new_testnet(config.clone())
                }
            }
        } else if let Ok(key_hex) = env::var("POOL_SIGNING_KEY") {
            match service.with_sweeper(&key_hex) {
                Ok(s) => {
                    println!("Sweeper configured with pool signing key");
                    s
                }
                Err(e) => {
                    eprintln!("Warning: Failed to configure sweeper: {}", e);
                    deposit_tracker::DepositTrackerService::new_testnet(config.clone())
                }
            }
        } else {
            service
        }
    } else if let Ok(key_hex) = env::var("POOL_SIGNING_KEY") {
        match service.with_sweeper(&key_hex) {
            Ok(s) => {
                println!("Sweeper configured with pool signing key");
                s
            }
            Err(e) => {
                eprintln!("Warning: Failed to configure sweeper: {}", e);
                deposit_tracker::DepositTrackerService::new_testnet(config.clone())
            }
        }
    } else {
        service
    };

    // Configure verifier if keypair available
    let service = if let Ok(keypair_path) = env::var("VERIFIER_KEYPAIR") {
        match zbtc::load_keypair_from_file(&keypair_path) {
            Ok(keypair) => {
                println!("Verifier configured with Solana keypair");
                service.with_verifier(keypair)
            }
            Err(e) => {
                eprintln!("Warning: Failed to load verifier keypair: {}", e);
                service
            }
        }
    } else {
        service
    };

    println!("=== zBTC Deposit Tracker ===");
    println!();
    println!("Configuration:");
    println!("  Poll Interval: {} seconds", config.poll_interval_secs);
    println!("  Required Confirmations: {}", config.required_confirmations);
    println!(
        "  Required Sweep Confirmations: {}",
        config.required_sweep_confirmations
    );
    println!("  Pool Address: {}", config.pool_receive_address);
    println!("  Database: {}", config.db_path);
    println!("  Max Retries: {}", config.max_retries);
    println!("  Retry Delay: {} seconds", config.retry_delay_secs);
    println!();
    println!("Watching for Bitcoin deposits...");
    println!("Press Ctrl+C to stop");
    println!();

    if let Err(e) = service.run().await {
        eprintln!("Error: {}", e);
    }
}

/// Configure FROST sweeper for the tracker service
fn configure_frost_sweeper(
    service: deposit_tracker::DepositTrackerService,
    _config: &TrackerConfig,
) -> Result<deposit_tracker::DepositTrackerService, String> {
    let zvault_config = ZVaultConfig::from_env().map_err(|e| e.to_string())?;

    let frost_client = zvault_config
        .signing
        .frost_client()
        .ok_or("signing mode is not FROST")?;

    let group_pubkey_hex = env::var("ZVAULT_FROST_GROUP_PUBKEY")
        .map_err(|_| "ZVAULT_FROST_GROUP_PUBKEY required for FROST mode".to_string())?;

    let group_pubkey_bytes = hex::decode(&group_pubkey_hex)
        .map_err(|e| format!("invalid group pubkey hex: {}", e))?;

    let group_pubkey = bitcoin::XOnlyPublicKey::from_slice(&group_pubkey_bytes)
        .map_err(|e| format!("invalid group pubkey: {}", e))?;

    let network = zvault_config.network.bitcoin_network();

    Ok(service.with_frost_sweeper(frost_client, group_pubkey, network))
}

async fn run_demo() {
    use zbtc::taproot::{generate_deposit_address, PoolKeys};
    use bitcoin::Network;

    println!("\n=== zBTC Demo ===\n");
    println!("Note: In production, use the SDK for client-side operations.");
    println!();

    // Create pool keys
    let pool_keys = PoolKeys::new();
    println!("Pool Public Key: {}", hex::encode(pool_keys.internal_key.serialize()));
    println!();

    // Generate a sample commitment
    let sample_commitment = [0x42u8; 32];
    let amount = 100_000u64; // 0.001 BTC

    // Generate deposit address
    let deposit_addr =
        generate_deposit_address(&pool_keys, &sample_commitment, Network::Testnet).unwrap();
    println!("Sample Deposit Address: {}", deposit_addr.address);
    println!("Amount: {}", units::format_sats(amount));
    println!();

    println!("=== Flow Overview ===");
    println!();
    println!("1. DEPOSIT (Client-side via SDK):");
    println!("   - SDK generates note (nullifier + secret)");
    println!("   - SDK derives taproot address");
    println!("   - User sends BTC externally");
    println!("   - SDK verifies via Esplora + submits to Solana");
    println!();
    println!("2. CLAIM (Client-side via SDK):");
    println!("   - SDK generates Groth16 ZK proof locally");
    println!("   - SDK submits claim transaction to Solana");
    println!("   - zBTC minted to user's wallet");
    println!();
    println!("3. WITHDRAW (Server-side redemption processor):");
    println!("   - User burns zBTC via SDK (creates RedemptionRequest PDA)");
    println!("   - Redemption processor detects request");
    println!("   - Processor signs and broadcasts BTC transaction");
    println!("   - Processor calls complete_redemption after confirms");
    println!();

    println!("=== Demo Complete ===");
}
