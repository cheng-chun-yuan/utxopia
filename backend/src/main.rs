//! UTXOpia Backend — Private Bitcoin Bridge Services
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
use zkbtc::config::UTXOpiaConfig;
use zkbtc::deposit_tracker::{self, TrackerConfig};
use zkbtc::deposit_tracker::sqlite_db::SqliteDepositStore;
use zkbtc::event_indexer::{EventIndexerConfig, EventIndexerService, EventStore, TreeCache, event_indexer_router_with_deposits, SolanaWsConfig, SolanaWsSubscriber, Reconciler};
use zkbtc::redemption::{IkaSigner, MpcSigner, RedemptionConfig, RedemptionService, SingleKeySigner};
use zkbtc::stealth::StealthDepositService;
use std::env;
use std::sync::Arc;
use std::str::FromStr;

#[tokio::main]
async fn main() {
    // Load .env file if present (won't override existing env vars)
    let _ = dotenv::dotenv();

    let args: Vec<String> = env::args().collect();

    let subcommand = args.get(1).map(|s| s.as_str()).unwrap_or("tracker");
    let sub_args = if args.len() > 2 { &args[2..] } else { &[] };

    match subcommand {
        "help" | "--help" | "-h" => print_usage(),
        _ => run_tracker_service(sub_args).await,
    }
}

fn print_usage() {
    println!("zkBTC Backend - Server-Side Services");
    println!();
    println!("Usage:");
    println!("  zkbtc-api [options]  Start all services (API + tracker + indexer)");
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
    println!("  UTXOPIA_PROGRAM_ID             UTXOpia program ID for event indexing");
    println!();
    println!("Note: Most functionality is handled by the SDK on the client side.");
    println!();
    println!("Header Relay (TypeScript):");
    println!("  cd backend/header-relayer && bun run start");
}

/// Create redemption service from environment.
/// Supports three modes: "single" (POC), "frost" (legacy), "ika" (v2 default).
fn create_service(config: RedemptionConfig) -> RedemptionService {
    if let Ok(mode) = env::var("UTXOPIA_SIGNING_MODE") {
        match mode.to_lowercase().as_str() {
            "frost" => {
                return match create_frost_service(config.clone()) {
                    Ok(service) => service,
                    Err(e) => {
                        eprintln!("Warning: Failed to configure FROST signing: {}", e);
                        eprintln!("Falling back to testnet single-key signer");
                        RedemptionService::new_testnet()
                    }
                };
            }
            "ika" => {
                return match create_ika_service(config.clone()) {
                    Ok(service) => service,
                    Err(e) => {
                        eprintln!("Warning: Failed to configure Ika signing: {}", e);
                        eprintln!("Falling back to testnet single-key signer");
                        RedemptionService::new_testnet()
                    }
                };
            }
            _ => {}
        }
    }

    // Single-key mode
    let mut sol_client = match UTXOpiaConfig::from_env() {
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
        // so program_id comes from UTXOPIA_PROGRAM_ID env var
        RedemptionService::new_with_signer(config, SingleKeySigner::generate(), sol_client)
    }
}

/// Create redemption service with FROST threshold signing
fn create_frost_service(config: RedemptionConfig) -> Result<RedemptionService, String> {
    let utxopia_config = UTXOpiaConfig::from_env().map_err(|e| e.to_string())?;

    let frost_client = utxopia_config
        .signing
        .frost_client()
        .ok_or("signing mode is not FROST")?;

    // Get group pubkey from UTXOPIA_FROST_GROUP_PUBKEY env var
    let group_pubkey_hex = env::var("UTXOPIA_FROST_GROUP_PUBKEY")
        .map_err(|_| "UTXOPIA_FROST_GROUP_PUBKEY required for FROST mode".to_string())?;

    let group_pubkey_bytes = hex::decode(&group_pubkey_hex)
        .map_err(|e| format!("invalid group pubkey hex: {}", e))?;

    let group_pubkey = bitcoin::XOnlyPublicKey::from_slice(&group_pubkey_bytes)
        .map_err(|e| format!("invalid group pubkey: {}", e))?;

    let signer = MpcSigner::new(frost_client, group_pubkey);
    let mut sol_client = zkbtc::solana::client::SolClient::from_config(&utxopia_config)
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

/// Create redemption service backed by an Ika dWallet (v2).
///
/// The IkaSigner does not produce signatures synchronously the way FROST does.
/// Instead, the backend asks the UTXOpia program to run `approve_redemption_signing`,
/// which CPIs `approve_message` on Ika before broadcast; the Ika network's
/// pre-alpha signer then fills a MessageApproval PDA that `IkaSigner` polls.
fn create_ika_service(config: RedemptionConfig) -> Result<RedemptionService, String> {
    let utxopia_config = UTXOpiaConfig::from_env().map_err(|e| e.to_string())?;

    let (program_id_str, dwallet_str, dwallet_xonly_hex) = match &utxopia_config.signing {
        zkbtc::config::SigningMode::Ika {
            program_id,
            dwallet,
            dwallet_xonly_pubkey,
            ..
        } => (program_id.clone(), dwallet.clone(), dwallet_xonly_pubkey.clone()),
        _ => return Err("signing mode is not Ika".to_string()),
    };

    let ika_program_id = program_id_str
        .parse::<solana_sdk::pubkey::Pubkey>()
        .map_err(|e| format!("invalid UTXOPIA_IKA_PROGRAM_ID: {}", e))?;
    let ika_dwallet = dwallet_str
        .parse::<solana_sdk::pubkey::Pubkey>()
        .map_err(|e| format!("invalid UTXOPIA_IKA_DWALLET: {}", e))?;
    let xonly_bytes = hex::decode(&dwallet_xonly_hex)
        .map_err(|e| format!("invalid IKA dwallet xonly hex: {}", e))?;
    let xonly = bitcoin::XOnlyPublicKey::from_slice(&xonly_bytes)
        .map_err(|e| format!("invalid IKA dwallet xonly pubkey: {}", e))?;

    let signer = IkaSigner::new(
        utxopia_config.solana_rpc.clone(),
        ika_program_id,
        ika_dwallet,
        xonly,
    );

    let mut sol_client = zkbtc::solana::client::SolClient::from_config(&utxopia_config)
        .map_err(|e| format!("SolClient config error: {}", e))?;

    if let Ok(keypair_val) = env::var("RELAYER_KEYPAIR").or_else(|_| env::var("VERIFIER_KEYPAIR")) {
        match zkbtc::common::keypair::load_keypair(&keypair_val) {
            Ok(keypair) => {
                println!("Redemption service: payer keypair set (Ika mode)");
                sol_client.set_payer(keypair);
            }
            Err(e) => {
                eprintln!("Warning: Failed to load payer keypair for Ika redemption: {}", e);
            }
        }
    }

    Ok(RedemptionService::new_with_signer(config, signer, sol_client))
}

// ---------------------------------------------------------------------------
// Tracker service — split into focused setup functions
// ---------------------------------------------------------------------------

/// Load tracker config from CLI args and environment variables.
fn load_tracker_config(args: &[String]) -> TrackerConfig {
    use zkbtc::common::env::{env_or, env_bool};

    let mut config = TrackerConfig::default();

    // Parse CLI arguments
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
    if config.pool_receive_address.trim().is_empty() {
        if let Some(addr) = derive_ika_pool_receive_address_from_env() {
            println!("Derived POOL_RECEIVE_ADDRESS from Ika dWallet x-only pubkey: {}", addr);
            config.pool_receive_address = addr;
        }
    }
    if let Ok(rpc) = env::var("UTXOPIA_SOLANA_RPC").or_else(|_| env::var("SOLANA_RPC_URL")) {
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

    config
}

fn derive_ika_pool_receive_address_from_env() -> Option<String> {
    let mode = env::var("UTXOPIA_SIGNING_MODE").ok()?;
    if mode.to_lowercase() != "ika" {
        return None;
    }

    let xonly_hex = env::var("UTXOPIA_IKA_DWALLET_XONLY_PUBKEY").ok()?;
    let xonly_bytes = hex::decode(xonly_hex).ok()?;
    if xonly_bytes.len() != 32 || xonly_bytes.iter().all(|b| *b == 0) {
        return None;
    }

    let xonly = bitcoin::XOnlyPublicKey::from_slice(&xonly_bytes).ok()?;
    let tweaked = bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(xonly);
    let btc_network = env::var("UTXOPIA_BITCOIN_NETWORK")
        .ok()
        .and_then(|network| bitcoin::Network::from_str(&network).ok())
        .unwrap_or(bitcoin::Network::Testnet);
    Some(bitcoin::Address::p2tr_tweaked(tweaked, btc_network).to_string())
}

/// Ensure the data directory exists when using the default db path.
fn ensure_data_dir(db_path: &str) {
    if db_path.starts_with("data/") {
        if let Err(e) = std::fs::create_dir_all("data") {
            eprintln!("Warning: Failed to create data directory: {}", e);
        }
    }
}

/// Create a deposit tracker service, choosing testnet or custom esplora based on env.
fn create_tracker_service(config: &TrackerConfig) -> deposit_tracker::DepositTrackerService {
    if env::var("ESPLORA_URL").is_ok() {
        deposit_tracker::DepositTrackerService::new(config.clone())
    } else {
        deposit_tracker::DepositTrackerService::new_testnet(config.clone())
    }
}

/// Configure the sweeper (FROST or single-key) on a tracker service.
fn configure_sweeper(
    service: deposit_tracker::DepositTrackerService,
    config: &TrackerConfig,
) -> deposit_tracker::DepositTrackerService {
    if let Ok(mode) = env::var("UTXOPIA_SIGNING_MODE") {
        if mode.to_lowercase() == "frost" {
            return match configure_frost_sweeper(service, config) {
                Ok(s) => {
                    println!("Sweeper configured with FROST threshold signing");
                    s
                }
                Err(e) => {
                    eprintln!("Warning: Failed to configure FROST sweeper: {}", e);
                    create_tracker_service(config)
                }
            };
        }
    }

    if let Ok(key_hex) = env::var("POOL_SIGNING_KEY") {
        match service.with_sweeper(&key_hex) {
            Ok(s) => {
                println!("Sweeper configured with pool signing key");
                s
            }
            Err(e) => {
                eprintln!("Warning: Failed to configure sweeper: {}", e);
                create_tracker_service(config)
            }
        }
    } else {
        service
    }
}

/// Attach a Solana verifier keypair to the tracker service if available.
fn configure_verifier(
    service: deposit_tracker::DepositTrackerService,
) -> deposit_tracker::DepositTrackerService {
    if let Ok(keypair_val) = env::var("VERIFIER_KEYPAIR") {
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
    }
}

/// Resolve the Solana RPC URL from environment variables.
fn solana_rpc_url() -> String {
    env::var("UTXOPIA_SOLANA_RPC")
        .or_else(|_| env::var("SOLANA_RPC_URL"))
        .unwrap_or_else(|_| "https://api.devnet.solana.com".to_string())
}

/// Resolve the UTXOPIA_PROGRAM_ID from the environment, returning None on failure.
fn require_utxopia_program_id() -> Option<String> {
    match env::var("UTXOPIA_PROGRAM_ID") {
        Ok(id) => Some(id),
        Err(_) => {
            eprintln!("ERROR: UTXOPIA_PROGRAM_ID env var is required.");
            eprintln!("Run: UTXOPIA_NETWORK=devnet ./scripts/sync-env.sh to generate .env files");
            None
        }
    }
}

/// Set up the event store (SQLite) and tree cache.
fn setup_event_store_and_tree(
    indexer_db_path: &str,
) -> Option<(Arc<EventStore>, Arc<TreeCache>)> {
    let event_store = match EventStore::new(indexer_db_path) {
        Ok(store) => Arc::new(store),
        Err(e) => {
            eprintln!("Failed to create event store at '{}': {}", indexer_db_path, e);
            return None;
        }
    };
    let tree_cache = match TreeCache::new(event_store.clone()) {
        Ok(cache) => Arc::new(cache),
        Err(e) => {
            eprintln!("Failed to create tree cache: {}", e);
            return None;
        }
    };
    Some((event_store, tree_cache))
}

/// Spawn the reconciler background task and return its status handle.
fn spawn_reconciler(
    solana_rpc: &str,
    program_pubkey: &solana_sdk::pubkey::Pubkey,
    event_store: Arc<EventStore>,
    tree_cache: Arc<TreeCache>,
) -> Arc<tokio::sync::RwLock<Option<zkbtc::event_indexer::reconciler::ReconciliationResult>>> {
    use zkbtc::common::env::env_or;

    let reconcile_interval: u64 = env_or("RECONCILE_INTERVAL_SECS", 60);
    let reconciler_status = Arc::new(tokio::sync::RwLock::new(None));

    let (pool_state_pda_pubkey, _) = solana_sdk::pubkey::Pubkey::find_program_address(
        &[b"pool_state"], program_pubkey,
    );
    let (commitment_tree_pda_pubkey, _) = solana_sdk::pubkey::Pubkey::find_program_address(
        &[b"commitment_tree"], program_pubkey,
    );
    let pool_state_pda = pool_state_pda_pubkey.to_string();
    let commitment_tree_pda = commitment_tree_pda_pubkey.to_string();
    println!("Derived pool_state PDA: {}", pool_state_pda);
    println!("Derived commitment_tree PDA: {}", commitment_tree_pda);

    let reconciler = Reconciler::new(
        solana_rpc.to_string(),
        pool_state_pda,
        commitment_tree_pda,
        event_store,
        tree_cache,
        reconcile_interval,
        reconciler_status.clone(),
    );
    tokio::spawn(async move {
        reconciler.run().await;
    });

    reconciler_status
}

/// Spawn the event indexer polling service.
fn spawn_event_indexer(
    solana_rpc: &str,
    utxopia_program_id: &str,
    event_store: Arc<EventStore>,
    tree_cache: Arc<TreeCache>,
) {
    use zkbtc::common::env::env_or;

    let indexer_poll_secs: u64 = env_or("INDEXER_POLL_INTERVAL_SECS", 10);
    let indexer_config = EventIndexerConfig {
        rpc_url: solana_rpc.to_string(),
        program_id: utxopia_program_id.to_string(),
        poll_interval_secs: indexer_poll_secs,
    };
    let indexer_service = match EventIndexerService::new(indexer_config, event_store) {
        Ok(svc) => svc.with_tree_cache(tree_cache),
        Err(e) => {
            eprintln!("Failed to create event indexer service: {}", e);
            return;
        }
    };

    tokio::spawn(async move {
        let mut svc = indexer_service;
        svc.run().await;
    });
}

/// Spawn the Solana WebSocket log subscriber for real-time events.
fn spawn_solana_ws_subscriber(
    solana_rpc: &str,
    utxopia_program_id: &str,
    event_store: Arc<EventStore>,
    tree_cache: Arc<TreeCache>,
) {
    let solana_ws_url = env::var("SOLANA_WS_URL")
        .unwrap_or_else(|_| derive_solana_ws_url(solana_rpc));
    let ws_subscriber = SolanaWsSubscriber::new(
        SolanaWsConfig {
            ws_url: solana_ws_url,
            program_id: utxopia_program_id.to_string(),
        },
        event_store,
        tree_cache,
    );
    tokio::spawn(async move {
        ws_subscriber.run().await;
    });
}

fn derive_solana_ws_url(solana_rpc: &str) -> String {
    if let Some(rest) = solana_rpc.strip_prefix("http://") {
        if rest.ends_with(":8899") {
            return format!("ws://{}:8900", rest.trim_end_matches(":8899"));
        }
        return format!("ws://{}", rest);
    }
    if let Some(rest) = solana_rpc.strip_prefix("https://") {
        return format!("wss://{}", rest);
    }
    solana_rpc.to_string()
}

/// Spawn the unified API server (deposit tracker + event indexer + stealth/redeem).
fn spawn_api_server(
    api_port: u16,
    api_tracker: deposit_tracker::DepositTrackerService,
    indexer_router: axum::Router,
    redemption_api: RedemptionService,
    stealth: StealthDepositService,
) {
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
}

/// Run the tracker service: deposit tracker + event indexer + redemption + API.
async fn run_tracker_service(args: &[String]) {
    use zkbtc::common::env::{env_or, env_string};

    let config = load_tracker_config(args);
    ensure_data_dir(&config.db_path);

    // Build and configure the deposit tracker
    let service = create_tracker_service(&config);
    let service = configure_sweeper(service, &config);
    let service = configure_verifier(service);
    let mut service = service;

    let api_port: u16 = env_or("TRACKER_API_PORT", 3001);

    print_tracker_banner(&config, api_port);

    // Create a separate tracker instance for the API server (shares same SQLite DB)
    let api_tracker = create_tracker_service(&config);

    // Resolve common env values
    let solana_rpc = solana_rpc_url();
    let utxopia_program_id = match require_utxopia_program_id() {
        Some(id) => id,
        None => return,
    };

    // Event store + tree cache
    let indexer_db_path = env_string("INDEXER_DB_PATH", "data/events.db");
    let (event_store, tree_cache) = match setup_event_store_and_tree(&indexer_db_path) {
        Some(pair) => pair,
        None => return,
    };

    // Parse and validate program pubkey
    let program_pubkey: solana_sdk::pubkey::Pubkey = match utxopia_program_id.parse() {
        Ok(pk) => pk,
        Err(e) => {
            eprintln!("Invalid UTXOPIA_PROGRAM_ID '{}': {}", utxopia_program_id, e);
            return;
        }
    };

    // Deposit store for reset endpoints
    let deposit_store = match SqliteDepositStore::new(&config.db_path) {
        Ok(store) => Arc::new(store),
        Err(e) => {
            eprintln!("Failed to open deposit store at '{}': {}", config.db_path, e);
            return;
        }
    };

    // Background services
    let reconciler_status = spawn_reconciler(
        &solana_rpc, &program_pubkey, event_store.clone(), tree_cache.clone(),
    );

    let indexer_router = event_indexer_router_with_deposits(
        event_store.clone(),
        tree_cache.clone(),
        program_pubkey,
        Some(deposit_store),
        reconciler_status,
    );

    spawn_event_indexer(&solana_rpc, &utxopia_program_id, event_store.clone(), tree_cache.clone());
    spawn_solana_ws_subscriber(&solana_rpc, &utxopia_program_id, event_store.clone(), tree_cache.clone());

    // Redemption + stealth services
    let redemption_config = RedemptionConfig::default();
    let redemption_api = create_service(redemption_config.clone());
    let stealth = StealthDepositService::new_testnet();

    let redemption_watcher = create_service(redemption_config);
    tokio::spawn(async move {
        println!("=== Redemption Watcher Started ===");
        if let Err(e) = redemption_watcher.run().await {
            eprintln!("Redemption watcher error: {}", e);
        }
    });

    // Unified API server
    spawn_api_server(api_port, api_tracker, indexer_router, redemption_api, stealth);

    // Run deposit tracker with graceful shutdown on SIGINT/SIGTERM
    let shutdown = tokio::signal::ctrl_c();
    tokio::select! {
        result = service.run() => {
            if let Err(e) = result {
                eprintln!("Deposit tracker error: {}", e);
            }
        }
        _ = shutdown => {
            println!("\n=== Shutting down gracefully ===");
        }
    }
}

fn print_tracker_banner(config: &TrackerConfig, api_port: u16) {
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
}

/// Configure FROST sweeper for the tracker service
fn configure_frost_sweeper(
    service: deposit_tracker::DepositTrackerService,
    _config: &TrackerConfig,
) -> Result<deposit_tracker::DepositTrackerService, String> {
    let utxopia_config = UTXOpiaConfig::from_env().map_err(|e| e.to_string())?;

    let frost_client = utxopia_config
        .signing
        .frost_client()
        .ok_or("signing mode is not FROST")?;

    let group_pubkey_hex = env::var("UTXOPIA_FROST_GROUP_PUBKEY")
        .map_err(|_| "UTXOPIA_FROST_GROUP_PUBKEY required for FROST mode".to_string())?;

    let group_pubkey_bytes = hex::decode(&group_pubkey_hex)
        .map_err(|e| format!("invalid group pubkey hex: {}", e))?;

    let group_pubkey = bitcoin::XOnlyPublicKey::from_slice(&group_pubkey_bytes)
        .map_err(|e| format!("invalid group pubkey: {}", e))?;

    let network = utxopia_config.network.bitcoin_network();

    Ok(service.with_frost_sweeper(frost_client, group_pubkey, network))
}
