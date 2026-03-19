//! Aegis Backend — Private Bitcoin Bridge Services
//!
//! Runs as a single binary with subcommands. Each mode starts a different
//! combination of background services:
//!
//! Run modes:
//!   cargo run -- api             - REST API + event indexer + deposit tracker + redemption
//!   cargo run -- redemption      - Standalone redemption processor
//!   cargo run -- tracker         - Standalone deposit tracker
//!   cargo run -- demo            - Interactive demo (create test deposits)
//!
//! Services (started automatically in `api` mode):
//! - **Event Indexer**: polls Solana for JoinSplit events, stores in SQLite
//! - **Deposit Tracker**: watches BTC addresses → sweep → SPV verify → mint
//! - **Redemption Service**: scans RedemptionRequest PDAs → FROST sign → send BTC
//! - **Header Relayer**: submits BTC block headers to btc-light-client program
//! - **REST API**: serves frontend requests (deposits, transfers, redemptions, proofs)

use zkbtc::api_server as api;
use zkbtc::config::AEGISConfig;
use zkbtc::deposit_tracker::{self, TrackerConfig};
use zkbtc::deposit_tracker::sqlite_db::SqliteDepositStore;
use zkbtc::event_indexer::{EventIndexerConfig, EventIndexerService, EventStore, TreeCache, event_indexer_router_with_deposits, SolanaWsConfig, SolanaWsSubscriber, Reconciler};
use zkbtc::redemption::{MpcSigner, RedemptionConfig, RedemptionService, SingleKeySigner};
use zkbtc::stealth::StealthDepositService;
use zkbtc::units;
use std::env;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    // Load .env file if present (won't override existing env vars)
    let _ = dotenv::dotenv();

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
    println!("zkBTC Backend - Server-Side Services");
    println!();
    println!("Usage:");
    println!("  zkbtc-api api [--port <port>]               Start REST API server (default: 3001)");
    println!("  zkbtc-api redemption [--interval <secs>]    Start redemption processor");
    println!("  zkbtc-api tracker [options]                 Start deposit tracker");
    println!("  zkbtc-api demo                              Run interactive demo");
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
    println!("  MEMPOOL_WS_ENABLED            Enable mempool.space WebSocket (default: true)");
    println!("  MEMPOOL_WS_URL                WebSocket URL (default: wss://mempool.space/testnet4/api/v1/ws)");
    println!("  HEADER_RELAY_ENABLED          Enable integrated block header relay (default: false)");
    println!("  BTC_LIGHT_CLIENT_PROGRAM_ID   BTC light client program ID on Solana");
    println!("  RELAYER_KEYPAIR               Solana keypair JSON for header relay submissions");
    println!("  HEADER_BATCH_SIZE             Headers per batch (2-10, default: 5)");
    println!("  INDEXER_DB_PATH               Event indexer SQLite path (default: data/events.db)");
    println!("  INDEXER_POLL_INTERVAL_SECS    Event indexer poll interval (default: 10)");
    println!("  AEGIS_PROGRAM_ID             Aegis program ID for event indexing");
    println!();
    println!("Note: Most functionality is handled by the SDK on the client side.");
    println!();
    println!("Header Relay (TypeScript):");
    println!("  cd backend/header-relayer && bun run start");
}

/// Create redemption service from environment, supporting both single-key and FROST modes
fn create_service(config: RedemptionConfig) -> RedemptionService {
    // Check for FROST signing mode first
    if let Ok(mode) = env::var("AEGIS_SIGNING_MODE") {
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
    let mut sol_client = match AEGISConfig::from_env() {
        Ok(cfg) => zkbtc::solana::client::SolClient::from_config(&cfg).unwrap_or_else(|_| {
            zkbtc::solana::client::SolClient::new(zkbtc::solana::client::SolConfig::default())
        }),
        Err(_) => zkbtc::solana::client::SolClient::new(zkbtc::solana::client::SolConfig::default()),
    };

    // Set payer keypair for on-chain transactions (mark_processing, complete_redemption)
    if let Ok(keypair_val) = env::var("RELAYER_KEYPAIR").or_else(|_| env::var("VERIFIER_KEYPAIR")) {
        match zkbtc::common::keypair::load_keypair(&keypair_val) {
            Ok(keypair) => {
                println!("Redemption service: payer keypair set");
                sol_client.set_payer(keypair);
            }
            Err(e) => {
                eprintln!("Warning: Failed to load payer keypair for redemption: {}", e);
            }
        }
    }

    if let Ok(key_hex) = env::var("POOL_SIGNING_KEY") {
        match SingleKeySigner::from_hex(&key_hex) {
            Ok(signer) => RedemptionService::new_with_signer(config, signer, sol_client),
            Err(e) => {
                eprintln!("Warning: Invalid POOL_SIGNING_KEY: {}", e);
                RedemptionService::new_with_signer(config, SingleKeySigner::generate(), sol_client)
            }
        }
    } else {
        // No signing key — use generated signer but keep env-based sol_client
        // so program_id comes from AEGIS_PROGRAM_ID env var
        RedemptionService::new_with_signer(config, SingleKeySigner::generate(), sol_client)
    }
}

/// Create redemption service with FROST threshold signing
fn create_frost_service(config: RedemptionConfig) -> Result<RedemptionService, String> {
    let aegis_config = AEGISConfig::from_env().map_err(|e| e.to_string())?;

    let frost_client = aegis_config
        .signing
        .frost_client()
        .ok_or("signing mode is not FROST")?;

    // Get group pubkey from AEGIS_FROST_GROUP_PUBKEY env var
    let group_pubkey_hex = env::var("AEGIS_FROST_GROUP_PUBKEY")
        .map_err(|_| "AEGIS_FROST_GROUP_PUBKEY required for FROST mode".to_string())?;

    let group_pubkey_bytes = hex::decode(&group_pubkey_hex)
        .map_err(|e| format!("invalid group pubkey hex: {}", e))?;

    let group_pubkey = bitcoin::XOnlyPublicKey::from_slice(&group_pubkey_bytes)
        .map_err(|e| format!("invalid group pubkey: {}", e))?;

    let signer = MpcSigner::new(frost_client, group_pubkey);
    let mut sol_client = zkbtc::solana::client::SolClient::from_config(&aegis_config)
        .map_err(|e| format!("SolClient config error: {}", e))?;

    // Set payer keypair for on-chain transactions (mark_processing, complete_redemption)
    if let Ok(keypair_val) = env::var("RELAYER_KEYPAIR").or_else(|_| env::var("VERIFIER_KEYPAIR")) {
        match zkbtc::common::keypair::load_keypair(&keypair_val) {
            Ok(keypair) => {
                println!("Redemption service: payer keypair set");
                sol_client.set_payer(keypair);
            }
            Err(e) => {
                eprintln!("Warning: Failed to load payer keypair for redemption: {}", e);
            }
        }
    }

    Ok(RedemptionService::new_with_signer(config, signer, sol_client))
}

async fn run_api_server(args: &[String]) {
    let mut port: u16 = zkbtc::common::env::env_or("API_PORT", 3001);

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

    println!("=== zkBTC Redemption Processor ===");
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
    use zkbtc::common::env::{env_or, env_bool, env_string};

    if let Ok(addr) = env::var("POOL_RECEIVE_ADDRESS") {
        config.pool_receive_address = addr;
    }
    if let Ok(rpc) = env::var("AEGIS_SOLANA_RPC").or_else(|_| env::var("SOLANA_RPC_URL")) {
        config.solana_rpc = rpc;
    }
    if let Ok(db_path) = env::var("DEPOSIT_DB_PATH") {
        config.db_path = db_path;
    }
    config.poll_interval_secs = env_or("DEPOSIT_POLL_INTERVAL_SECS", config.poll_interval_secs);
    config.required_confirmations = env_or("DEPOSIT_REQUIRED_CONFIRMATIONS", config.required_confirmations);
    config.max_retries = env_or("DEPOSIT_MAX_RETRIES", config.max_retries);
    if let Ok(esplora) = env::var("ESPLORA_URL") {
        config.esplora_url = esplora;
    }

    // WebSocket config
    config.ws_enabled = env_bool("MEMPOOL_WS_ENABLED", config.ws_enabled);
    if let Ok(ws_url) = env::var("MEMPOOL_WS_URL") {
        config.ws_url = ws_url;
    }

    // Header relay config (integrated into deposit tracker)
    config.header_relay_enabled = env_bool("HEADER_RELAY_ENABLED", config.header_relay_enabled);
    if let Ok(program_id) = env::var("BTC_LIGHT_CLIENT_PROGRAM_ID") {
        config.btc_light_client_program_id = program_id;
    }
    if let Ok(keypair) = env::var("RELAYER_KEYPAIR") {
        config.relayer_keypair = keypair;
    }
    config.header_batch_size = env_or("HEADER_BATCH_SIZE", config.header_batch_size);

    // Create data directory if using default path
    if config.db_path.starts_with("data/") {
        if let Err(e) = std::fs::create_dir_all("data") {
            eprintln!("Warning: Failed to create data directory: {}", e);
        }
    }

    // Create service — use custom esplora_url if set, otherwise default testnet
    let has_custom_esplora = env::var("ESPLORA_URL").is_ok();
    let service = if has_custom_esplora {
        deposit_tracker::DepositTrackerService::new(config.clone())
    } else {
        deposit_tracker::DepositTrackerService::new_testnet(config.clone())
    };

    // Configure sweeper based on signing mode
    let service = if let Ok(mode) = env::var("AEGIS_SIGNING_MODE") {
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

    // Configure verifier if keypair available (supports inline JSON or file path)
    let service = if let Ok(keypair_val) = env::var("VERIFIER_KEYPAIR") {
        match zkbtc::common::keypair::load_keypair(&keypair_val) {
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
    let mut service = service;

    // API server port
    let api_port: u16 = env_or("TRACKER_API_PORT", 3001);

    println!("=== zkBTC Deposit Tracker ===");
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
    println!("  API Port: {}", api_port);
    println!();
    println!("Watching for Bitcoin deposits...");
    println!("Press Ctrl+C to stop");
    println!();

    // Create a separate tracker instance for the API server (shares same SQLite DB)
    let has_custom_esplora_api = env::var("ESPLORA_URL").is_ok();
    let api_tracker = if has_custom_esplora_api {
        deposit_tracker::DepositTrackerService::new(config.clone())
    } else {
        deposit_tracker::DepositTrackerService::new_testnet(config.clone())
    };

    // =========================================================================
    // Event Indexer + Merkle Tree Cache
    // =========================================================================

    let indexer_db_path = env_string("INDEXER_DB_PATH", "data/events.db");
    let indexer_poll_secs: u64 = env_or("INDEXER_POLL_INTERVAL_SECS", 10);
    let solana_rpc = std::env::var("AEGIS_SOLANA_RPC")
        .or_else(|_| std::env::var("SOLANA_RPC_URL"))
        .unwrap_or_else(|_| "https://api.devnet.solana.com".to_string());
    let aegis_program_id = env_string("AEGIS_PROGRAM_ID", "7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ");

    let event_store = match EventStore::new(&indexer_db_path) {
        Ok(store) => Arc::new(store),
        Err(e) => {
            eprintln!("Failed to create event store at '{}': {}", indexer_db_path, e);
            return;
        }
    };
    let tree_cache = match TreeCache::new(event_store.clone()) {
        Ok(cache) => Arc::new(cache),
        Err(e) => {
            eprintln!("Failed to create tree cache: {}", e);
            return;
        }
    };

    // Build the indexer router (proof, status, sync, ws, leaves, nullifiers)
    let program_pubkey: solana_sdk::pubkey::Pubkey = match aegis_program_id.parse() {
        Ok(pk) => pk,
        Err(e) => {
            eprintln!("Invalid AEGIS_PROGRAM_ID '{}': {}", aegis_program_id, e);
            return;
        }
    };
    // Create a deposit store handle so reset endpoints can clear stale tracker data
    let deposit_store = match SqliteDepositStore::new(&config.db_path) {
        Ok(store) => Arc::new(store),
        Err(e) => {
            eprintln!("Failed to open deposit store at '{}': {}", config.db_path, e);
            return;
        }
    };

    // Reconciler: compare on-chain state with local SQLite periodically
    let reconcile_interval: u64 = env_or("RECONCILE_INTERVAL_SECS", 60);
    let reconciler_status = Arc::new(tokio::sync::RwLock::new(None));

    // Derive PDAs from program ID (deterministic, no extra env vars needed)
    let (pool_state_pda_pubkey, _) = solana_sdk::pubkey::Pubkey::find_program_address(
        &[b"pool_state"], &program_pubkey,
    );
    let (commitment_tree_pda_pubkey, _) = solana_sdk::pubkey::Pubkey::find_program_address(
        &[b"commitment_tree"], &program_pubkey,
    );
    let pool_state_pda = pool_state_pda_pubkey.to_string();
    let commitment_tree_pda = commitment_tree_pda_pubkey.to_string();
    println!("Derived pool_state PDA: {}", pool_state_pda);
    println!("Derived commitment_tree PDA: {}", commitment_tree_pda);

    let reconciler = Reconciler::new(
        solana_rpc.clone(),
        pool_state_pda,
        commitment_tree_pda,
        event_store.clone(),
        tree_cache.clone(),
        reconcile_interval,
        reconciler_status.clone(),
    );
    tokio::spawn(async move {
        reconciler.run().await;
    });

    let indexer_router = event_indexer_router_with_deposits(
        event_store.clone(),
        tree_cache.clone(),
        program_pubkey,
        Some(deposit_store),
        reconciler_status,
    );

    // Start the event indexer service in background
    let solana_rpc_clone = solana_rpc.clone();
    let aegis_program_id_clone = aegis_program_id.clone();
    let indexer_config = EventIndexerConfig {
        rpc_url: solana_rpc,
        program_id: aegis_program_id,
        poll_interval_secs: indexer_poll_secs,
    };
    let indexer_service = match EventIndexerService::new(indexer_config, event_store.clone()) {
        Ok(svc) => svc.with_tree_cache(tree_cache.clone()),
        Err(e) => {
            eprintln!("Failed to create event indexer service: {}", e);
            return;
        }
    };

    tokio::spawn(async move {
        let mut svc = indexer_service;
        svc.run().await;
    });

    // Start Solana logsSubscribe for real-time event detection
    let solana_ws_url = env::var("SOLANA_WS_URL").unwrap_or_else(|_| {
        solana_rpc_clone.replace("https://", "wss://").replace("http://", "ws://")
    });
    let ws_subscriber = SolanaWsSubscriber::new(
        SolanaWsConfig {
            ws_url: solana_ws_url,
            program_id: aegis_program_id_clone,
        },
        event_store.clone(),
        tree_cache.clone(),
    );
    tokio::spawn(async move {
        ws_subscriber.run().await;
    });

    // Create stealth + redemption services (previously in backend-api)
    let redemption_config = RedemptionConfig::default();
    let redemption_api = create_service(redemption_config.clone());
    let stealth = StealthDepositService::new_testnet();

    // Spawn the redemption watcher (PDA scanner loop) in background
    let redemption_watcher = create_service(redemption_config);
    tokio::spawn(async move {
        println!("=== Redemption Watcher Started ===");
        if let Err(e) = redemption_watcher.run().await {
            eprintln!("Redemption watcher error: {}", e);
        }
    });

    // Spawn the unified API server (deposit tracker + event indexer + stealth/redeem) in background
    tokio::spawn(async move {
        let deposit_router = deposit_tracker::api::create_deposit_router(api_tracker);
        let api_router = api::create_combined_router(redemption_api, stealth);
        let merged = api_router.merge(deposit_router).merge(indexer_router);

        let addr = std::net::SocketAddr::from(([0, 0, 0, 0], api_port));
        println!("=== zkBTC Unified API ===");
        println!("Listening on http://{}", addr);
        println!();
        println!("Stealth Endpoints:");
        println!("  POST /api/stealth/prepare              - Prepare stealth deposit");
        println!("  GET  /api/stealth/status/:id           - Stealth deposit status");
        println!("  POST /api/stealth/announce             - Manual announcement");
        println!();
        println!("Tree Endpoints:");
        println!("  GET  /api/tree/proof?commitment=<hex>  - Merkle proof");
        println!("  GET  /api/tree/status                  - Tree root/size");
        println!("  GET  /api/tree/leaves                  - All leaves");
        println!("  POST /api/tree/sync                    - Force rebuild");
        println!("  WS   /ws/tree                          - Live tree updates");
        println!();

        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Failed to bind to {}: {}", addr, e);
                return;
            }
        };
        if let Err(e) = axum::serve(listener, merged).await {
            eprintln!("API server error: {}", e);
        }
    });

    if let Err(e) = service.run().await {
        eprintln!("Error: {}", e);
    }
}

/// Configure FROST sweeper for the tracker service
fn configure_frost_sweeper(
    service: deposit_tracker::DepositTrackerService,
    _config: &TrackerConfig,
) -> Result<deposit_tracker::DepositTrackerService, String> {
    let aegis_config = AEGISConfig::from_env().map_err(|e| e.to_string())?;

    let frost_client = aegis_config
        .signing
        .frost_client()
        .ok_or("signing mode is not FROST")?;

    let group_pubkey_hex = env::var("AEGIS_FROST_GROUP_PUBKEY")
        .map_err(|_| "AEGIS_FROST_GROUP_PUBKEY required for FROST mode".to_string())?;

    let group_pubkey_bytes = hex::decode(&group_pubkey_hex)
        .map_err(|e| format!("invalid group pubkey hex: {}", e))?;

    let group_pubkey = bitcoin::XOnlyPublicKey::from_slice(&group_pubkey_bytes)
        .map_err(|e| format!("invalid group pubkey: {}", e))?;

    let network = aegis_config.network.bitcoin_network();

    Ok(service.with_frost_sweeper(frost_client, group_pubkey, network))
}

async fn run_demo() {
    use zkbtc::bitcoin::taproot::{generate_deposit_address, PoolKeys};
    use bitcoin::Network;

    println!("\n=== zkBTC Demo ===\n");
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
    println!("   - zkBTC minted to user's wallet");
    println!();
    println!("3. WITHDRAW (Server-side redemption processor):");
    println!("   - User burns zkBTC via SDK (creates RedemptionRequest PDA)");
    println!("   - Redemption processor detects request");
    println!("   - Processor signs and broadcasts BTC transaction");
    println!("   - Processor calls complete_redemption after confirms");
    println!();

    println!("=== Demo Complete ===");
}
