//! FROST Signer Server CLI
//!
//! Entry point for running FROST signer nodes or DKG ceremonies.

use clap::{Parser, Subcommand};
use frost_server::{create_router, AppState, Keystore};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Parser)]
#[command(name = "frost-server")]
#[command(about = "FROST threshold signing server for zVault")]
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
        } => {
            run_server(bind, id, key_file, password).await?;
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
) -> Result<(), Box<dyn std::error::Error>> {
    let key_path = key_file.unwrap_or_else(|| format!("config/signer{}.key.enc", signer_id));

    tracing::info!(
        signer_id = signer_id,
        key_path = %key_path,
        "Starting FROST signer server"
    );

    let keystore = Keystore::new(&key_path, signer_id);
    let keystore_for_load = Keystore::new(&key_path, signer_id);
    let state = Arc::new(AppState::new(signer_id, keystore, password));

    // Try to load existing key
    if keystore_for_load.exists() {
        match state.load_key(&keystore_for_load).await {
            Ok(()) => tracing::info!("Loaded existing key share"),
            Err(e) => tracing::warn!("Failed to load key: {}. Run DKG to generate keys.", e),
        }
    } else {
        tracing::info!("No key file found. Run DKG to generate keys.");
    }

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

    // Round 1: Collect packages from all signers
    tracing::info!("DKG Round 1: Collecting commitments...");
    let mut round1_packages: BTreeMap<u16, String> = BTreeMap::new();

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
    }

    // Round 2: Have each signer generate shares
    tracing::info!("DKG Round 2: Generating shares...");
    let mut round2_packages: BTreeMap<u16, BTreeMap<u16, String>> = BTreeMap::new();

    for signer_url in &signers {
        let request = DkgRound2Request {
            ceremony_id,
            round1_packages: round1_packages.clone(),
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
    tracing::info!("Taproot address: tb1p{}", bech32_encode(&group_pubkey)?);

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
    tracing::info!("Taproot address: tb1p{}", bech32_encode(&x_only)?);

    // Save group public key to file
    let pubkey_path = format!("{}/group_pubkey.txt", output_dir);
    std::fs::write(&pubkey_path, &x_only)?;
    tracing::info!("Saved group public key to {}", pubkey_path);

    Ok(())
}

/// Simple bech32m encoding for Taproot address (testnet)
fn bech32_encode(hex_pubkey: &str) -> Result<String, Box<dyn std::error::Error>> {
    // For a proper implementation, use the bech32 crate
    // This is a placeholder that just returns the hex for now
    // In production, use bitcoin crate's Address type
    Ok(format!("...{}", &hex_pubkey[..8]))
}
