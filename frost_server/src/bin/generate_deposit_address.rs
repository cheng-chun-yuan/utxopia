//! Generate Dual-Path Deposit Address with FROST Group Key
//!
//! Creates a Taproot address with:
//! - Key path: FROST group (admin can sweep immediately)
//! - Script path: User can refund after 144 blocks (~24 hours)
//!
//! Usage:
//!   cargo run --bin generate_deposit_address -- --user-pubkey <hex> --commitment <hex>
//!   cargo run --bin generate_deposit_address -- --user-pubkey <hex>  # auto-generate commitment

use bitcoin::hashes::Hash;
use bitcoin::key::Secp256k1;
use bitcoin::opcodes::all::*;
use bitcoin::script::Builder as ScriptBuilder;
use bitcoin::taproot::{LeafVersion, TaprootBuilder};
use bitcoin::{Address, Network, XOnlyPublicKey};
use clap::Parser;
use sha2::{Digest, Sha256};

// FROST group public key from DKG
const FROST_GROUP_PUBKEY: &str = "e1b15704047c53ed8f40778789d997e79294ae368f53324ffbc8e4df9bb2dfad";

// Timelock: 144 blocks ≈ 24 hours on mainnet, 6 blocks for testnet
const TIMELOCK_BLOCKS_TESTNET: u16 = 6;
const TIMELOCK_BLOCKS_MAINNET: u16 = 144;

#[derive(Parser)]
#[command(name = "generate_deposit_address")]
#[command(about = "Generate dual-path Taproot deposit address with FROST + user refund")]
struct Args {
    /// User's x-only public key (32 bytes hex) for refund path
    #[arg(short, long)]
    user_pubkey: String,

    /// Commitment (32 bytes hex). If not provided, generates random.
    #[arg(short, long)]
    commitment: Option<String>,

    /// Network: testnet or mainnet
    #[arg(short, long, default_value = "testnet")]
    network: String,

    /// Timelock in blocks (default: 6 for testnet, 144 for mainnet)
    #[arg(short, long)]
    timelock: Option<u16>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let secp = Secp256k1::new();

    // Parse network
    let network = match args.network.as_str() {
        "mainnet" | "bitcoin" => Network::Bitcoin,
        "testnet" | "testnet3" => Network::Testnet,
        "signet" => Network::Signet,
        _ => {
            eprintln!("Unknown network: {}. Using testnet.", args.network);
            Network::Testnet
        }
    };

    // Default timelock based on network
    let timelock = args.timelock.unwrap_or(if network == Network::Bitcoin {
        TIMELOCK_BLOCKS_MAINNET
    } else {
        TIMELOCK_BLOCKS_TESTNET
    });

    // Parse FROST group pubkey (internal key for key path)
    let frost_pubkey_bytes = hex::decode(FROST_GROUP_PUBKEY)?;
    let frost_pubkey = XOnlyPublicKey::from_slice(&frost_pubkey_bytes)?;

    // Parse user pubkey (for script path refund)
    let user_pubkey_bytes = hex::decode(&args.user_pubkey)?;
    if user_pubkey_bytes.len() != 32 {
        return Err(format!("User pubkey must be 32 bytes, got {}", user_pubkey_bytes.len()).into());
    }
    let user_pubkey = XOnlyPublicKey::from_slice(&user_pubkey_bytes)?;

    // Parse or generate commitment
    let commitment: [u8; 32] = if let Some(c) = args.commitment {
        let bytes = hex::decode(&c)?;
        if bytes.len() != 32 {
            return Err(format!("Commitment must be 32 bytes, got {}", bytes.len()).into());
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        arr
    } else {
        // Generate random commitment
        let mut arr = [0u8; 32];
        getrandom::getrandom(&mut arr)?;
        arr
    };

    println!("╔════════════════════════════════════════════════════════════╗");
    println!("║     Dual-Path Taproot Deposit Address Generator            ║");
    println!("╚════════════════════════════════════════════════════════════╝\n");

    println!("Input Parameters:");
    println!("  Network: {:?}", network);
    println!("  FROST Group Key: {}", FROST_GROUP_PUBKEY);
    println!("  User Pubkey: {}", args.user_pubkey);
    println!("  Commitment: {}", hex::encode(&commitment));
    println!("  Timelock: {} blocks", timelock);

    // Build the refund script: <user_pubkey> OP_CHECKSIGVERIFY <timelock> OP_CSV
    let refund_script = ScriptBuilder::new()
        .push_x_only_key(&user_pubkey)
        .push_opcode(OP_CHECKSIGVERIFY)
        .push_int(timelock as i64)
        .push_opcode(OP_CSV)
        .into_script();

    println!("\nRefund Script:");
    println!("  Hex: {}", hex::encode(refund_script.as_bytes()));
    println!("  ASM: {}", refund_script.to_asm_string());

    // Build Taproot tree with refund script as leaf
    let builder = TaprootBuilder::new()
        .add_leaf(0, refund_script.clone())
        .expect("Failed to add leaf");

    // Finalize with FROST group key as internal key
    let taproot_spend_info = builder
        .finalize(&secp, frost_pubkey)
        .expect("Failed to finalize taproot");

    // Get the output key (includes script tree tweak)
    let output_key = taproot_spend_info.output_key();

    // Now apply commitment tweak for unique address per deposit
    let commitment_tweak = compute_commitment_tweak(&output_key.to_x_only_public_key(), &commitment);
    let scalar = bitcoin::secp256k1::Scalar::from_be_bytes(commitment_tweak)
        .expect("Invalid scalar");

    let (final_output_key, _parity) = output_key
        .to_x_only_public_key()
        .add_tweak(&secp, &scalar)
        .expect("Tweak failed");

    // Create the final address
    let address = Address::p2tr_tweaked(
        bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(final_output_key),
        network,
    );

    // Compute control block for script path spending
    let control_block = taproot_spend_info
        .control_block(&(refund_script.clone(), LeafVersion::TapScript))
        .expect("Failed to get control block");

    println!("\n╔════════════════════════════════════════════════════════════╗");
    println!("║                    DEPOSIT ADDRESS                         ║");
    println!("╚════════════════════════════════════════════════════════════╝\n");

    println!("  {}\n", address);

    println!("Spending Paths:");
    println!("  1. KEY PATH (FROST Admin - Immediate):");
    println!("     - FROST 2-of-3 signers can sweep immediately");
    println!("     - Used for normal deposit processing");
    println!();
    println!("  2. SCRIPT PATH (User Refund - After {} blocks):", timelock);
    println!("     - You can refund after ~{} hours if not processed", timelock as f64 * 10.0 / 60.0);
    println!("     - Requires your signature + timelock expiry");

    println!("\nData to Save (for refund):");
    println!("  Output Key: {}", hex::encode(final_output_key.serialize()));
    println!("  Merkle Root: {}", hex::encode(taproot_spend_info.merkle_root().unwrap().to_byte_array()));
    println!("  Control Block: {}", hex::encode(control_block.serialize()));
    println!("  Refund Script: {}", hex::encode(refund_script.as_bytes()));
    println!("  Commitment: {}", hex::encode(&commitment));

    Ok(())
}

/// Compute commitment tweak: H_zVault/CommitmentTweak(output_key || commitment)
fn compute_commitment_tweak(output_key: &XOnlyPublicKey, commitment: &[u8; 32]) -> [u8; 32] {
    let tag_hash = Sha256::digest(b"zVault/CommitmentTweak");

    let mut hasher = Sha256::new();
    hasher.update(&tag_hash);
    hasher.update(&tag_hash);
    hasher.update(&output_key.serialize());
    hasher.update(commitment);
    hasher.finalize().into()
}
