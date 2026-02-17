//! Sweep Dual-Path Taproot UTXO with FROST
//!
//! Sweeps a UTXO from a dual-path Taproot address (FROST + user refund)
//! using FROST 2-of-3 threshold signing via the key path.
//!
//! Usage:
//!   cargo run --bin sweep_dual_path -- --txid <txid> --vout <n> --amount <sats> \
//!       --user-pubkey <hex> --destination <address>

use bitcoin::consensus::encode::serialize_hex;
use bitcoin::hashes::Hash;
use bitcoin::key::Secp256k1;
use bitcoin::opcodes::all::*;
use bitcoin::script::Builder as ScriptBuilder;
use bitcoin::secp256k1::schnorr::Signature as SchnorrSignature;
use bitcoin::sighash::{Prevouts, SighashCache, TapSighashType};
use bitcoin::taproot::{TaprootBuilder, Signature as TaprootSignature};
use bitcoin::{
    absolute, transaction, Address, Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction,
    TxIn, TxOut, Txid, Witness, XOnlyPublicKey,
};
use clap::Parser;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::str::FromStr;

// FROST signer URLs
const SIGNER_URLS: [&str; 3] = [
    "http://localhost:9001",
    "http://localhost:9002",
    "http://localhost:9003",
];

// FROST group public key from DKG
const FROST_GROUP_PUBKEY: &str = "92a9fbe6a99d2f3ebdead240d6c4e5f0e30668459c79bc6d080a5746202de2db";

// Esplora API
const ESPLORA_API: &str = "https://blockstream.info/testnet/api";

#[derive(Parser)]
#[command(name = "sweep_dual_path")]
#[command(about = "Sweep dual-path Taproot UTXO using FROST key path")]
struct Args {
    /// UTXO transaction ID
    #[arg(long)]
    txid: String,

    /// UTXO output index
    #[arg(long, default_value = "0")]
    vout: u32,

    /// UTXO amount in satoshis
    #[arg(long)]
    amount: u64,

    /// User's x-only public key (for reconstructing the address)
    #[arg(long)]
    user_pubkey: String,

    /// Destination address
    #[arg(long)]
    destination: String,

    /// Timelock blocks (must match address generation)
    #[arg(long, default_value = "6")]
    timelock: u16,

    /// Fee in satoshis
    #[arg(long, default_value = "200")]
    fee: u64,
}

// API types for FROST signing
#[derive(Debug, Serialize)]
struct Round1Request {
    session_id: String,
    sighash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tweak: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Round1Response {
    commitment: String,
    signer_id: u16,
    frost_identifier: String,
}

#[derive(Debug, Serialize)]
struct Round2Request {
    session_id: String,
    sighash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tweak: Option<String>,
    commitments: BTreeMap<u16, String>,
    identifier_map: BTreeMap<u16, String>,
}

#[derive(Debug, Deserialize)]
struct Round2Response {
    signature_share: String,
    signer_id: u16,
}

#[derive(Debug, Serialize)]
struct AggregateRequest {
    commitments: BTreeMap<u16, String>,
    identifier_map: BTreeMap<u16, String>,
    signature_shares: BTreeMap<u16, String>,
    sighash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    merkle_root: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AggregateResponse {
    signature: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let secp = Secp256k1::new();
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    println!("╔════════════════════════════════════════════════════════════╗");
    println!("║     FROST Sweep - Dual-Path Taproot Key Path Spend         ║");
    println!("╚════════════════════════════════════════════════════════════╝\n");

    // Parse inputs
    let frost_pubkey_bytes = hex::decode(FROST_GROUP_PUBKEY)?;
    let frost_pubkey = XOnlyPublicKey::from_slice(&frost_pubkey_bytes)?;

    let user_pubkey_bytes = hex::decode(&args.user_pubkey)?;
    let user_pubkey = XOnlyPublicKey::from_slice(&user_pubkey_bytes)?;

    let dest_address = Address::from_str(&args.destination)?.require_network(Network::Testnet)?;

    // Reconstruct the Taproot address to get the tweak
    println!("Reconstructing Taproot address...");
    println!("  FROST Group Key: {}", FROST_GROUP_PUBKEY);
    println!("  User Pubkey: {}", args.user_pubkey);
    println!("  Timelock: {} blocks", args.timelock);

    // Build refund script (same as in address generation)
    let refund_script = ScriptBuilder::new()
        .push_x_only_key(&user_pubkey)
        .push_opcode(OP_CHECKSIGVERIFY)
        .push_int(args.timelock as i64)
        .push_opcode(OP_CSV)
        .into_script();

    println!("  Refund Script: {}", refund_script.to_asm_string());

    // Build Taproot tree
    let builder = TaprootBuilder::new()
        .add_leaf(0, refund_script.clone())
        .expect("Failed to add leaf");

    let taproot_spend_info = builder
        .finalize(&secp, frost_pubkey)
        .expect("Failed to finalize taproot");

    // Get the output key (this is the BIP-341 tweaked key)
    let output_key = taproot_spend_info.output_key();
    let merkle_root = taproot_spend_info.merkle_root();

    // Reconstruct address
    let reconstructed_address = Address::p2tr_tweaked(output_key, Network::Testnet);
    println!("\n  Reconstructed Address: {}", reconstructed_address);

    // Build transaction
    println!("\nUTXO to sweep:");
    println!("  TXID: {}", args.txid);
    println!("  VOUT: {}", args.vout);
    println!("  Amount: {} sats", args.amount);

    let send_amount = args.amount.saturating_sub(args.fee);
    if send_amount < 546 {
        return Err("Amount too small after fees".into());
    }

    println!("\nSweep Details:");
    println!("  Destination: {}", args.destination);
    println!("  Amount: {} sats", send_amount);
    println!("  Fee: {} sats", args.fee);

    let txid = Txid::from_str(&args.txid)?;
    let outpoint = OutPoint::new(txid, args.vout);

    let mut tx = Transaction {
        version: transaction::Version::TWO,
        lock_time: absolute::LockTime::ZERO,
        input: vec![TxIn {
            previous_output: outpoint,
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::from_sat(send_amount),
            script_pubkey: dest_address.script_pubkey(),
        }],
    };

    // Compute sighash
    println!("\n=== Computing BIP-341 Sighash ===\n");

    let prevout_script = ScriptBuf::new_p2tr_tweaked(output_key);
    let prevout = TxOut {
        value: Amount::from_sat(args.amount),
        script_pubkey: prevout_script,
    };

    let mut sighash_cache = SighashCache::new(&tx);
    let sighash = sighash_cache.taproot_key_spend_signature_hash(
        0,
        &Prevouts::All(&[prevout]),
        TapSighashType::Default,
    )?;

    let sighash_bytes: [u8; 32] = sighash.to_byte_array();
    let sighash_hex = hex::encode(&sighash_bytes);
    println!("Sighash: {}", sighash_hex);

    // Get merkle root for Taproot tweak (used during aggregation)
    let merkle_root_hex = merkle_root.map(|mr| {
        use bitcoin::hashes::Hash;
        hex::encode(mr.to_byte_array())
    });
    println!("Merkle Root: {:?}", merkle_root_hex);

    // FROST signing
    println!("\n=== FROST 2-of-3 Threshold Signing ===\n");

    let session_id = uuid::Uuid::new_v4().to_string();
    println!("Session: {}", session_id);

    // Round 1 (no tweak needed - tweak is applied during aggregation)
    println!("\nRound 1: Collecting commitments...");
    let mut commitments: BTreeMap<u16, String> = BTreeMap::new();
    let mut identifier_map: BTreeMap<u16, String> = BTreeMap::new();

    for url in SIGNER_URLS.iter().take(2) {
        let request = Round1Request {
            session_id: session_id.clone(),
            sighash: sighash_hex.clone(),
            tweak: None, // Tweak applied at aggregation, not here
        };

        let response: Round1Response = client
            .post(format!("{}/round1", url))
            .json(&request)
            .send()?
            .json()?;

        println!("  Signer {}: OK", response.signer_id);
        commitments.insert(response.signer_id, response.commitment);
        identifier_map.insert(response.signer_id, response.frost_identifier);
    }

    // Round 2 (no tweak needed - tweak is applied during aggregation)
    println!("\nRound 2: Collecting signature shares...");
    let mut signature_shares: BTreeMap<u16, String> = BTreeMap::new();

    for url in SIGNER_URLS.iter().take(2) {
        let request = Round2Request {
            session_id: session_id.clone(),
            sighash: sighash_hex.clone(),
            tweak: None, // Tweak applied at aggregation, not here
            commitments: commitments.clone(),
            identifier_map: identifier_map.clone(),
        };

        let response: Round2Response = client
            .post(format!("{}/round2", url))
            .json(&request)
            .send()?
            .json()?;

        println!("  Signer {}: OK", response.signer_id);
        signature_shares.insert(response.signer_id, response.signature_share);
    }

    // Aggregate with Taproot tweak (merkle_root)
    println!("\nAggregating signature with Taproot tweak...");

    let aggregate_request = AggregateRequest {
        commitments,
        identifier_map,
        signature_shares,
        sighash: sighash_hex,
        merkle_root: merkle_root_hex, // This triggers aggregate_with_tweak on server
    };

    let aggregate_response: AggregateResponse = client
        .post(format!("{}/aggregate", SIGNER_URLS[0]))
        .json(&aggregate_request)
        .send()?
        .json()?;

    println!("Signature: {}...", &aggregate_response.signature[..32]);

    // Attach signature
    println!("\n=== Broadcasting Transaction ===\n");

    let sig_bytes = hex::decode(&aggregate_response.signature)?;
    let schnorr_sig = SchnorrSignature::from_slice(&sig_bytes)?;
    let taproot_sig = TaprootSignature {
        signature: schnorr_sig,
        sighash_type: TapSighashType::Default,
    };

    tx.input[0].witness.push(taproot_sig.to_vec());

    let signed_tx_hex = serialize_hex(&tx);

    // Broadcast
    let broadcast_response = client
        .post(format!("{}/tx", ESPLORA_API))
        .body(signed_tx_hex.clone())
        .send()?;

    if broadcast_response.status().is_success() {
        let new_txid = broadcast_response.text()?;
        println!("Transaction broadcast successfully!");
        println!("TXID: {}", new_txid);
        println!("\nhttps://mempool.space/testnet/tx/{}", new_txid);
    } else {
        let error_text = broadcast_response.text()?;
        println!("Broadcast failed: {}", error_text);
        println!("\nSigned transaction:");
        println!("{}", signed_tx_hex);
    }

    Ok(())
}
