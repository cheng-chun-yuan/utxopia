//! FROST Signer Server CLI
//!
//! Entry point for running FROST signer nodes or DKG ceremonies.

use clap::{Parser, Subcommand};
use frost_server::{create_router, AuditLog, AppState, Keystore, SigningPolicy};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Parser)]
#[command(name = "frost-server")]
#[command(about = "FROST threshold signing server for Aegis")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run the signer server
    Run {
        /// Bind address (e.g., 0.0.0.0:9001)
        #[arg(short, long, default_value = "0.0.0.0:9001")]
        bind: String,

        /// Signer ID (1-indexed)
        #[arg(short = 'i', long)]
        id: u16,

        /// Path to encrypted key file
        #[arg(short, long)]
        key_file: Option<String>,

        /// Key password (or set FROST_KEY_PASSWORD env var)
        #[arg(short, long, env = "FROST_KEY_PASSWORD")]
        password: String,

        /// Esplora API URL for UTXO verification
        #[arg(long, env = "FROST_ESPLORA_URL")]
        esplora_url: Option<String>,

        /// Pool wallet address (allowed destination for sweeps).
        /// Can be specified multiple times or comma-separated.
        #[arg(long, env = "FROST_POOL_ADDRESS")]
        pool_address: Option<String>,

        /// Maximum signing amount in sats (default: 10 BTC = 1_000_000_000)
        #[arg(long, env = "FROST_MAX_AMOUNT", default_value = "1000000000")]
        max_amount: u64,

        /// Maximum miner fee in sats (default: 2000, matching service fee base)
        #[arg(long, env = "FROST_MAX_FEE", default_value = "2000")]
        max_fee: u64,

        /// Require signing context (reject blind signing)
        #[arg(long, env = "FROST_REQUIRE_CONTEXT")]
        require_context: bool,

        /// Path to audit log file (JSON-lines). Disabled if not set.
        #[arg(long, env = "FROST_AUDIT_LOG")]
        audit_log: Option<String>,

        /// Bitcoin network: bitcoin, testnet, testnet4, signet, regtest
        #[arg(long, env = "FROST_NETWORK", default_value = "testnet")]
        network: String,

        /// Solana RPC URL for on-chain verification (e.g., http://localhost:8899)
        #[arg(long, env = "FROST_SOLANA_RPC_URL")]
        solana_rpc_url: Option<String>,

        /// Aegis program ID for PDA derivation (base58)
        #[arg(long, env = "FROST_AEGIS_PROGRAM_ID")]
        aegis_program_id: Option<String>,
    },

    /// Run DKG ceremony coordinator
    DkgCoordinator {
        /// Comma-separated signer URLs
        #[arg(short, long)]
        signers: String,

        /// Threshold (t of n)
        #[arg(short, long, default_value = "2")]
        threshold: u16,

        /// Key password to use for saving
        #[arg(short, long, env = "FROST_KEY_PASSWORD")]
        password: String,
    },

    /// Generate test keys using trusted dealer (for development only)
    GenerateTestKeys {
        /// Output directory
        #[arg(short, long, default_value = "config")]
        output_dir: String,

        /// Threshold (t of n)
        #[arg(short, long, default_value = "2")]
        threshold: u16,

        /// Total participants
        #[arg(short = 'n', long, default_value = "3")]
        total: u16,

        /// Key password
        #[arg(short, long, env = "FROST_KEY_PASSWORD")]
        password: String,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info,frost_server=debug".to_string()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Run {
            bind,
            id,
            key_file,
            password,
            esplora_url,
            pool_address,
            max_amount,
            max_fee,
            require_context,
            audit_log,
            network,
            solana_rpc_url,
            aegis_program_id,
        } => {
            run_server(
                bind, id, key_file, password, esplora_url, pool_address,
                max_amount, max_fee, require_context, audit_log, network,
                solana_rpc_url, aegis_program_id,
            )
            .await?;
        }
        Commands::DkgCoordinator {
            signers,
            threshold,
            password,
        } => {
            run_dkg_coordinator(signers, threshold, password).await?;
        }
        Commands::GenerateTestKeys {
            output_dir,
            threshold,
            total,
            password,
        } => {
            generate_test_keys(output_dir, threshold, total, password)?;
        }
    }

    Ok(())
}

/// Run the signer server
async fn run_server(
    bind: String,
    signer_id: u16,
    key_file: Option<String>,
    password: String,
    esplora_url: Option<String>,
    pool_address: Option<String>,
    max_amount: u64,
    max_fee: u64,
    require_context: bool,
    audit_log_path: Option<String>,
    network_str: String,
    solana_rpc_url: Option<String>,
    aegis_program_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let key_path = key_file.unwrap_or_else(|| format!("config/signer{}.key.enc", signer_id));

    let network = match network_str.as_str() {
        "bitcoin" | "mainnet" => bitcoin::Network::Bitcoin,
        "testnet4" => bitcoin::Network::Testnet,
        "signet" => bitcoin::Network::Signet,
        "regtest" => bitcoin::Network::Regtest,
        _ => bitcoin::Network::Testnet,
    };

    // Default esplora URL to mempool.space based on network string if not explicitly set
    let esplora_url = esplora_url.or_else(|| {
        let default_url = match network_str.as_str() {
            "bitcoin" | "mainnet" => "https://mempool.space/api",
            "testnet4" => "https://mempool.space/testnet4/api",
            "signet" => "https://mempool.space/signet/api",
            "regtest" => "http://localhost:2140",
            _ => "https://mempool.space/testnet/api",
        };
        Some(default_url.to_string())
    });

    tracing::info!(
        signer_id = signer_id,
        key_path = %key_path,
        require_context = require_context,
        network = %network_str,
        "Starting FROST signer server"
    );

    // Parse allowed destinations (comma-separated)
    let allowed_destinations: Vec<String> = pool_address
        .map(|s| s.split(',').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect())
        .unwrap_or_default();

    if !allowed_destinations.is_empty() {
        tracing::info!(destinations = ?allowed_destinations, "Allowed destinations configured");
    }

    // Build Solana verifier (if configured)
    let solana_verifier = match (&solana_rpc_url, &aegis_program_id) {
        (Some(rpc_url), Some(program_id)) => {
            match frost_server::solana_verifier::SolanaVerifier::new(rpc_url.clone(), program_id) {
                Ok(v) => {
                    tracing::info!(
                        rpc_url = %rpc_url,
                        program_id = %program_id,
                        "Solana on-chain verifier enabled"
                    );
                    Some(v)
                }
                Err(e) => {
                    tracing::error!(error = %e, "Failed to create Solana verifier — continuing without it");
                    None
                }
            }
        }
        (Some(_), None) | (None, Some(_)) => {
            tracing::warn!("Both --solana-rpc-url and --aegis-program-id are required for Solana verification");
            None
        }
        _ => None,
    };

    // Build policy
    let has_policy = require_context || esplora_url.is_some() || !allowed_destinations.is_empty() || solana_verifier.is_some();
    let policy = if has_policy {
        tracing::info!(
            esplora = ?esplora_url,
            max_amount_sats = max_amount,
            max_fee_sats = max_fee,
            solana_verification = solana_verifier.is_some(),
            "Signing policy enabled"
        );
        let mut p = SigningPolicy::new(
            esplora_url,
            allowed_destinations,
            max_amount,
            max_fee,
            require_context,
            network,
        );
        if let Some(v) = solana_verifier {
            p = p.with_solana_verifier(v);
        }
        Some(p)
    } else {
        tracing::warn!("No signing policy configured — blind signing is allowed (dev mode)");
        None
    };

    // Build audit log
    let audit_path = audit_log_path.map(std::path::PathBuf::from);
    let audit = AuditLog::new(audit_path);

    // Build duplicate tracker from audit log history
    let signed_history = audit.scan_signed_redemptions();
    let duplicate_tracker = Arc::new(frost_server::DuplicateTracker::new(signed_history));

    // Wire duplicate tracker into policy
    let policy = policy.map(|p| p.with_duplicate_tracker(Arc::clone(&duplicate_tracker)));

    let keystore = Keystore::new(&key_path, signer_id);
    let keystore_for_load = Keystore::new(&key_path, signer_id);
    let mut app_state = AppState::new(signer_id, keystore, password);
    if let Some(p) = policy {
        app_state = app_state.with_policy(p);
    }
    app_state = app_state.with_audit(audit);
    app_state = app_state.with_duplicate_tracker(duplicate_tracker);
    let state = Arc::new(app_state);

    // Try to load existing key
    if keystore_for_load.exists() {
        match state.load_key(&keystore_for_load).await {
            Ok(()) => tracing::info!("Loaded existing key share"),
            Err(e) => tracing::warn!("Failed to load key: {}. Run DKG to generate keys.", e),
        }
    } else {
        tracing::info!("No key file found. Run DKG to generate keys.");
    }

    // Spawn background session cleanup task (every 60s)
    let cleanup_state = Arc::clone(&state);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;

            // Clean up stale signing sessions
            let signer_guard = cleanup_state.signer.read().await;
            if let Some(ref signer) = *signer_guard {
                let before = signer.active_sessions();
                signer.cleanup_sessions();
                let after = signer.active_sessions();
                if before != after {
                    tracing::info!(
                        removed = before - after,
                        remaining = after,
                        "cleaned up stale signing sessions"
                    );
                }
            }
            drop(signer_guard);

            // Clean up stale DKG ceremonies
            cleanup_state.dkg.cleanup_ceremonies();

            // Clean up stale session verification data (retain entries younger than 5 min, matching signing session TTL)
            {
                let mut verifications = cleanup_state.session_verifications.write().await;
                let before = verifications.len();
                verifications.retain(|_, (_, _, created_at)| created_at.elapsed() < std::time::Duration::from_secs(300));
                let removed = before - verifications.len();
                if removed > 0 {
                    tracing::debug!(
                        removed = removed,
                        remaining = verifications.len(),
                        "cleaned up stale session verification data"
                    );
                }
            }
        }
    });

    let app = create_router(state);
    let addr: SocketAddr = bind.parse()?;

    tracing::info!("Listening on {}", addr);

    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// Run DKG ceremony as coordinator
async fn run_dkg_coordinator(
    signers_str: String,
    threshold: u16,
    _password: String,
) -> Result<(), Box<dyn std::error::Error>> {
    use frost_server::types::*;
    use std::collections::BTreeMap;

    let signers: Vec<&str> = signers_str.split(',').map(|s| s.trim()).collect();
    let total = signers.len() as u16;

    if threshold > total {
        return Err("Threshold cannot be greater than total signers".into());
    }

    tracing::info!(
        threshold = threshold,
        total = total,
        "Starting DKG ceremony"
    );

    let client = reqwest::Client::new();
    let ceremony_id = uuid::Uuid::new_v4();

    // Round 1: Collect packages and X25519 public keys from all signers
    tracing::info!("DKG Round 1: Collecting commitments...");
    let mut round1_packages: BTreeMap<u16, String> = BTreeMap::new();
    let mut x25519_pubkeys: BTreeMap<u16, String> = BTreeMap::new();

    for (idx, signer_url) in signers.iter().enumerate() {
        let request = DkgRound1Request {
            ceremony_id,
            threshold,
            total_participants: total,
        };

        let response: DkgRound1Response = client
            .post(format!("{}/dkg/round1", signer_url))
            .json(&request)
            .send()
            .await?
            .json()
            .await?;

        tracing::info!("  Signer {} (id={}) completed round 1", idx + 1, response.signer_id);
        round1_packages.insert(response.signer_id, response.package);
        x25519_pubkeys.insert(response.signer_id, response.x25519_public_key);
    }

    tracing::info!("All {} signers provided X25519 keys — round 2 will be E2E encrypted", signers.len());

    // Round 2: Have each signer generate shares
    tracing::info!("DKG Round 2: Generating shares...");
    let mut round2_packages: BTreeMap<u16, BTreeMap<u16, String>> = BTreeMap::new();

    for signer_url in &signers {
        let request = DkgRound2Request {
            ceremony_id,
            round1_packages: round1_packages.clone(),
            x25519_pubkeys: x25519_pubkeys.clone(),
        };

        let response: DkgRound2Response = client
            .post(format!("{}/dkg/round2", signer_url))
            .json(&request)
            .send()
            .await?
            .json()
            .await?;

        tracing::info!("  Signer {} completed round 2", response.signer_id);
        round2_packages.insert(response.signer_id, response.packages);
    }

    // Finalize: Each signer computes their key share
    tracing::info!("DKG Finalize: Computing key shares...");
    let mut group_pubkey = String::new();

    for (idx, signer_url) in signers.iter().enumerate() {
        let signer_id = (idx + 1) as u16;

        // Collect round 2 packages sent TO this signer
        let mut packages_for_signer: BTreeMap<u16, String> = BTreeMap::new();
        for (sender_id, packages) in &round2_packages {
            if let Some(pkg) = packages.get(&signer_id) {
                packages_for_signer.insert(*sender_id, pkg.clone());
            }
        }

        let request = DkgFinalizeRequest {
            ceremony_id,
            round1_packages: round1_packages.clone(),
            round2_packages: packages_for_signer,
            x25519_pubkeys: x25519_pubkeys.clone(),
        };

        let response: DkgFinalizeResponse = client
            .post(format!("{}/dkg/finalize", signer_url))
            .json(&request)
            .send()
            .await?
            .json()
            .await?;

        tracing::info!(
            "  Signer {} finalized (saved={})",
            response.signer_id,
            response.saved
        );

        if group_pubkey.is_empty() {
            group_pubkey = response.group_public_key.clone();
        } else if group_pubkey != response.group_public_key {
            return Err("Group public keys don't match!".into());
        }
    }

    tracing::info!("DKG ceremony completed successfully!");
    tracing::info!("Group public key (x-only): {}", group_pubkey);
    tracing::info!("Taproot address: {}", bech32_encode(&group_pubkey)?);

    Ok(())
}

/// Generate test keys using trusted dealer (development only)
fn generate_test_keys(
    output_dir: String,
    threshold: u16,
    total: u16,
    password: String,
) -> Result<(), Box<dyn std::error::Error>> {
    use frost_secp256k1_tr as frost;
    use rand::rngs::OsRng;

    tracing::warn!("Generating test keys with trusted dealer - FOR DEVELOPMENT ONLY!");

    let mut rng = OsRng;
    let (shares, pubkey_package) =
        frost::keys::generate_with_dealer(total, threshold, frost::keys::IdentifierList::Default, &mut rng)?;

    // Create output directory
    std::fs::create_dir_all(&output_dir)?;

    // Convert SecretShare to KeyPackage for each participant
    // Use enumeration for signer_id (1-indexed) since FROST identifiers are scalars
    for (idx, (_identifier, secret_share)) in shares.into_iter().enumerate() {
        let signer_id = (idx + 1) as u16;
        let key_path = format!("{}/signer{}.key.enc", output_dir, signer_id);

        // Convert SecretShare to KeyPackage
        let key_package = frost::keys::KeyPackage::try_from(secret_share)?;

        let keystore = Keystore::new(&key_path, signer_id);
        keystore.save(&key_package, &pubkey_package, &password)?;

        tracing::info!("Saved key share for signer {} to {}", signer_id, key_path);
    }

    // Output group public key
    let vk = pubkey_package.verifying_key();
    let vk_bytes = vk.serialize()?;
    let x_only = hex::encode(&vk_bytes[1..33]);

    tracing::info!("Group public key (x-only): {}", x_only);
    tracing::info!("Taproot address: {}", bech32_encode(&x_only)?);

    // Save group public key to file
    let pubkey_path = format!("{}/group_pubkey.txt", output_dir);
    std::fs::write(&pubkey_path, &x_only)?;
    tracing::info!("Saved group public key to {}", pubkey_path);

    Ok(())
}

/// Encode an x-only public key as a Taproot bech32m address (testnet)
fn bech32_encode(hex_pubkey: &str) -> Result<String, Box<dyn std::error::Error>> {
    use bitcoin::key::TweakedPublicKey;
    use bitcoin::{Address, Network, XOnlyPublicKey};

    let pubkey_bytes = hex::decode(hex_pubkey)?;
    let xonly = XOnlyPublicKey::from_slice(&pubkey_bytes)?;
    let address = Address::p2tr_tweaked(
        TweakedPublicKey::dangerous_assume_tweaked(xonly),
        Network::Testnet,
    );
    Ok(address.to_string())
}
