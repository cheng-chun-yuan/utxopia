//! Simple Dual-Path Deposit Address (Standard BIP-341 Only)
//!
//! Creates a Taproot address with:
//! - Key path: FROST group (admin can sweep immediately)
//! - Script path: User can refund after 6 blocks
//!
//! NO extra commitment tweak - just standard BIP-341 taptweak.
//!
//! Usage:
//!   cargo run --bin simple_deposit -- --user-pubkey <32-byte-hex>

use bitcoin::hashes::Hash;
use bitcoin::key::Secp256k1;
use bitcoin::opcodes::all::*;
use bitcoin::script::Builder as ScriptBuilder;
use bitcoin::taproot::TaprootBuilder;
use bitcoin::{Address, Network, XOnlyPublicKey};
use clap::Parser;

// FROST group public key from DKG
const FROST_GROUP_PUBKEY: &str = "92a9fbe6a99d2f3ebdead240d6c4e5f0e30668459c79bc6d080a5746202de2db";

// Timelock: 6 blocks for testnet
const TIMELOCK_BLOCKS: u16 = 6;

#[derive(Parser)]
#[command(name = "simple_deposit")]
#[command(about = "Generate simple dual-path Taproot deposit address (standard BIP-341)")]
struct Args {
    /// User's x-only public key (32 bytes hex) for refund path
    #[arg(short, long)]
    user_pubkey: Option<String>,

    /// Generate random user keypair for testing
    #[arg(long)]
    generate: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let secp = Secp256k1::new();

    println!("╔════════════════════════════════════════════════════════════╗");
    println!("║     Simple Dual-Path Taproot Deposit (BIP-341 Standard)    ║");
    println!("╚════════════════════════════════════════════════════════════╝\n");

    // Get or generate user pubkey
    let (user_secret, user_pubkey) = if args.generate {
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed)?;
        let secret = bitcoin::secp256k1::SecretKey::from_slice(&seed)?;
        let keypair = bitcoin::key::Keypair::from_secret_key(&secp, &secret);
        let (pubkey, _) = keypair.x_only_public_key();
        println!("Generated User Keypair:");
        println!("  Secret: {} (SAVE THIS!)", hex::encode(seed));
        println!("  Pubkey: {}", hex::encode(pubkey.serialize()));
        (Some(seed), pubkey)
    } else if let Some(ref pubkey_hex) = args.user_pubkey {
        let pubkey_bytes = hex::decode(pubkey_hex)?;
        if pubkey_bytes.len() != 32 {
            return Err(format!("User pubkey must be 32 bytes, got {}", pubkey_bytes.len()).into());
        }
        let pubkey = XOnlyPublicKey::from_slice(&pubkey_bytes)?;
        println!("Using User Pubkey: {}", pubkey_hex);
        (None, pubkey)
    } else {
        return Err("Please provide --user-pubkey or use --generate".into());
    };

    // Parse FROST group key
    let frost_pubkey_bytes = hex::decode(FROST_GROUP_PUBKEY)?;
    let frost_pubkey = XOnlyPublicKey::from_slice(&frost_pubkey_bytes)?;

    println!("\nFROST Group Key: {}", FROST_GROUP_PUBKEY);

    // Build refund script: <user_pubkey> OP_CHECKSIGVERIFY <timelock> OP_CSV
    let refund_script = ScriptBuilder::new()
        .push_x_only_key(&user_pubkey)
        .push_opcode(OP_CHECKSIGVERIFY)
        .push_int(TIMELOCK_BLOCKS as i64)
        .push_opcode(OP_CSV)
        .into_script();

    println!("\nRefund Script:");
    println!("  ASM: {}", refund_script.to_asm_string());
    println!("  Hex: {}", hex::encode(refund_script.as_bytes()));

    // Build Taproot tree with refund script
    let builder = TaprootBuilder::new()
        .add_leaf(0, refund_script.clone())
        .expect("Failed to add leaf");

    let taproot_spend_info = builder
        .finalize(&secp, frost_pubkey)
        .expect("Failed to finalize taproot");

    // Get output key and merkle root
    let output_key = taproot_spend_info.output_key();
    let merkle_root = taproot_spend_info.merkle_root();

    // Create deposit address (NO extra commitment tweak - just standard BIP-341)
    let deposit_address = Address::p2tr_tweaked(output_key, Network::Testnet);

    println!("\n╔════════════════════════════════════════════════════════════╗");
    println!("║                    DEPOSIT ADDRESS                         ║");
    println!("╚════════════════════════════════════════════════════════════╝\n");

    println!("  {}\n", deposit_address);

    println!("Spending Paths:");
    println!("  1. KEY PATH (FROST Admin):");
    println!("     - FROST 2-of-3 can sweep immediately");
    println!("     - Use merkle_root in aggregation for Taproot tweak");
    println!();
    println!("  2. SCRIPT PATH (User Refund after {} blocks):", TIMELOCK_BLOCKS);
    println!("     - You can refund after timelock expires");
    println!("     - Requires user signature + witness");

    println!("\nData for Sweep (save this!):");
    println!("  User Pubkey: {}", hex::encode(user_pubkey.serialize()));
    println!("  Output Key: {}", hex::encode(output_key.to_inner().serialize()));
    if let Some(mr) = merkle_root {
        println!("  Merkle Root: {}", hex::encode(mr.to_byte_array()));
    }
    println!("  Timelock: {} blocks", TIMELOCK_BLOCKS);

    if let Some(secret) = user_secret {
        println!("\n  User Secret: {} (for refund)", hex::encode(secret));
    }

    Ok(())
}
