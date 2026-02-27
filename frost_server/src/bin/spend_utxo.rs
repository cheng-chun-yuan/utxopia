//! FROST Threshold Spending - Sweep UTXO with 2-of-3 threshold signature
//!
//! This binary:
//! 1. Builds a proper BIP-341 Taproot sighash
//! 2. Collects FROST signature shares from threshold signers
//! 3. Aggregates shares into a valid Schnorr signature via /aggregate endpoint
//! 4. Broadcasts the signed transaction to Bitcoin testnet
//!
//! Usage: cargo run --bin spend_utxo -- \
//!   --signer-urls http://localhost:9001,http://localhost:9002,http://localhost:9003 \
//!   --utxo-txid b548a007... --utxo-vout 0 --utxo-amount 10000 \
//!   --group-pubkey e1b157... --destination tb1p3e44... \
//!   --fee 200 --esplora-api https://mempool.space/testnet/api

use bitcoin::consensus::encode::serialize_hex;
use bitcoin::hashes::Hash;
use bitcoin::key::Secp256k1;
use bitcoin::secp256k1::schnorr::Signature as SchnorrSignature;
use bitcoin::sighash::{Prevouts, SighashCache, TapSighashType};
use bitcoin::taproot::Signature as TaprootSignature;
use bitcoin::{
    absolute, transaction, Address, Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction,
    TxIn, TxOut, Txid, Witness, XOnlyPublicKey,
};
use clap::Parser;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::str::FromStr;

#[derive(Parser)]
#[command(name = "spend_utxo")]
#[command(about = "Sweep a UTXO using FROST 2-of-3 threshold signature")]
struct Cli {
    /// Comma-separated FROST signer URLs (e.g., http://localhost:9001,http://localhost:9002,http://localhost:9003)
    #[arg(long, value_delimiter = ',')]
    signer_urls: Vec<String>,

    /// UTXO transaction ID to spend
    #[arg(long)]
    utxo_txid: String,

    /// UTXO output index
    #[arg(long, default_value = "0")]
    utxo_vout: u32,

    /// UTXO amount in satoshis
    #[arg(long)]
    utxo_amount: u64,

    /// FROST group public key (x-only hex, 64 chars)
    #[arg(long)]
    group_pubkey: String,

    /// Destination Bitcoin address
    #[arg(long)]
    destination: String,

    /// Fee in satoshis
    #[arg(long, default_value = "200")]
    fee: u64,

    /// Esplora API base URL
    #[arg(long, env = "ESPLORA_URL", default_value = "https://mempool.space/testnet/api")]
    esplora_api: String,

    /// Bitcoin network (bitcoin, testnet, signet, regtest)
    #[arg(long, default_value = "testnet")]
    network: String,

    /// Number of signers required (threshold)
    #[arg(long, default_value = "2")]
    threshold: usize,

    /// Optional API key for FROST servers
    #[arg(long, env = "FROST_API_KEY")]
    api_key: Option<String>,

    /// Skip UTXO verification on-chain
    #[arg(long)]
    skip_verify: bool,

    /// Build and print signed tx without broadcasting
    #[arg(long)]
    dry_run: bool,
}

// API types
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
struct VerifyCommitmentsRequest {
    session_id: String,
    commitments: BTreeMap<u16, String>,
    identifier_map: BTreeMap<u16, String>,
}

#[derive(Debug, Deserialize)]
struct VerifyCommitmentsResponse {
    signer_id: u16,
    digest: String,
}

#[derive(Debug, Serialize)]
struct AggregateRequest {
    commitments: BTreeMap<u16, String>,
    identifier_map: BTreeMap<u16, String>,
    signature_shares: BTreeMap<u16, String>,
    sighash: String,
}

#[derive(Debug, Deserialize)]
struct AggregateResponse {
    signature: String,
    group_public_key: String,
}

fn post_json<T: Serialize>(
    client: &Client,
    url: &str,
    body: &T,
    api_key: &Option<String>,
) -> Result<reqwest::blocking::Response, reqwest::Error> {
    let mut req = client.post(url).json(body);
    if let Some(ref key) = api_key {
        req = req.header("X-API-Key", key);
    }
    req.send()
}

fn parse_network(s: &str) -> Result<Network, String> {
    match s.to_lowercase().as_str() {
        "bitcoin" | "mainnet" => Ok(Network::Bitcoin),
        "testnet" | "testnet3" => Ok(Network::Testnet),
        "signet" => Ok(Network::Signet),
        "regtest" => Ok(Network::Regtest),
        other => Err(format!("unknown network: {}", other)),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    let network = parse_network(&cli.network)?;
    let threshold = cli.threshold;

    if cli.signer_urls.len() < threshold {
        return Err(format!(
            "need at least {} signer URLs, got {}",
            threshold,
            cli.signer_urls.len()
        )
        .into());
    }

    println!("╔════════════════════════════════════════════════════════════╗");
    println!("║     FROST Threshold Sweep - Real Bitcoin Transaction       ║");
    println!("╚════════════════════════════════════════════════════════════╝\n");

    let _secp = Secp256k1::new();
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    // Parse group public key
    let group_pubkey_bytes = hex::decode(&cli.group_pubkey)?;
    let group_pubkey = XOnlyPublicKey::from_slice(&group_pubkey_bytes)?;

    println!("UTXO to sweep:");
    println!("  TXID: {}", cli.utxo_txid);
    println!("  VOUT: {}", cli.utxo_vout);
    println!("  Amount: {} sats", cli.utxo_amount);
    println!("  Group Pubkey: {}", cli.group_pubkey);

    println!("\nDestination: {}", cli.destination);
    println!("Fee: {} sats", cli.fee);
    println!("Output: {} sats", cli.utxo_amount - cli.fee);
    println!("Network: {:?}", network);
    println!("Threshold: {}-of-{}", threshold, cli.signer_urls.len());

    let api_key = cli.api_key.clone();

    // Step 1: Check UTXO still exists
    if !cli.skip_verify {
        println!("\n=== Step 1: Verifying UTXO exists ===\n");

        let utxo_check: serde_json::Value = client
            .get(format!("{}/tx/{}", cli.esplora_api, cli.utxo_txid))
            .send()?
            .json()?;

        let status = utxo_check.get("status").and_then(|s| s.get("confirmed"));
        if status == Some(&serde_json::Value::Bool(true)) {
            println!("UTXO confirmed on-chain");
        } else {
            println!("WARNING: UTXO may not be confirmed");
        }
    } else {
        println!("\n=== Step 1: Skipping UTXO verification ===\n");
    }

    // Step 2: Build unsigned transaction
    println!("\n=== Step 2: Building unsigned transaction ===\n");

    let txid = Txid::from_str(&cli.utxo_txid)?;
    let outpoint = OutPoint::new(txid, cli.utxo_vout);

    // Parse destination address
    let dest_address = Address::from_str(&cli.destination)?.require_network(network)?;

    // Create the transaction
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
            value: Amount::from_sat(cli.utxo_amount - cli.fee),
            script_pubkey: dest_address.script_pubkey(),
        }],
    };

    println!("Transaction built:");
    println!("  Input: {}:{}", cli.utxo_txid, cli.utxo_vout);
    println!(
        "  Output: {} sats to {}",
        cli.utxo_amount - cli.fee,
        cli.destination
    );

    // Step 3: Compute BIP-341 Taproot sighash
    println!("\n=== Step 3: Computing BIP-341 sighash ===\n");

    use bitcoin::key::TweakedPublicKey;
    let tweaked_pubkey = TweakedPublicKey::dangerous_assume_tweaked(group_pubkey);
    let prevout_script = ScriptBuf::new_p2tr_tweaked(tweaked_pubkey);
    let prevout = TxOut {
        value: Amount::from_sat(cli.utxo_amount),
        script_pubkey: prevout_script,
    };

    let mut sighash_cache = SighashCache::new(&tx);
    let sighash = sighash_cache.taproot_key_spend_signature_hash(
        0,
        &Prevouts::All(&[prevout.clone()]),
        TapSighashType::Default,
    )?;

    let sighash_bytes: [u8; 32] = sighash.to_byte_array();
    let sighash_hex = hex::encode(&sighash_bytes);

    println!("Sighash: {}", sighash_hex);

    // Step 4: FROST threshold signing
    println!(
        "\n=== Step 4: FROST {}-of-{} signing ===\n",
        threshold,
        cli.signer_urls.len()
    );

    let session_id = uuid::Uuid::new_v4().to_string();
    println!("Session: {}", session_id);

    // Round 1: Collect commitments (no tweak - deposit address uses raw internal key)
    println!("\nRound 1: Collecting commitments...");
    let mut commitments: BTreeMap<u16, String> = BTreeMap::new();
    let mut identifier_map: BTreeMap<u16, String> = BTreeMap::new();

    for url in cli.signer_urls.iter().take(threshold) {
        let request = Round1Request {
            session_id: session_id.clone(),
            sighash: sighash_hex.clone(),
            tweak: None, // No tweak - address uses raw internal key
        };

        let response: Round1Response = post_json(&client, &format!("{}/round1", url), &request, &api_key)?
            .json()?;

        println!("  Signer {}: OK", response.signer_id);
        commitments.insert(response.signer_id, response.commitment);
        identifier_map.insert(response.signer_id, response.frost_identifier);
    }

    // Broadcast Verification: Verify all signers received the same commitments
    println!("\nBroadcast Verification: Verifying commitment digests...");
    let mut digests: BTreeMap<u16, String> = BTreeMap::new();

    for url in cli.signer_urls.iter().take(threshold) {
        let request = VerifyCommitmentsRequest {
            session_id: session_id.clone(),
            commitments: commitments.clone(),
            identifier_map: identifier_map.clone(),
        };

        let response: VerifyCommitmentsResponse =
            post_json(&client, &format!("{}/verify-commitments", url), &request, &api_key)?
                .json()?;

        println!(
            "  Signer {}: digest={}",
            response.signer_id,
            &response.digest[..16]
        );
        digests.insert(response.signer_id, response.digest);
    }

    // Verify all digests match
    let digest_values: Vec<&String> = digests.values().collect();
    if digest_values.windows(2).any(|w| w[0] != w[1]) {
        eprintln!("ABORT: Commitment digest mismatch detected!");
        eprintln!("Digests: {:?}", digests);
        return Err("Broadcast channel verification failed — possible equivocation".into());
    }
    println!("  All digests match — broadcast channel verified");

    // Round 2: Collect signature shares (no tweak - deposit address uses raw internal key)
    println!("\nRound 2: Collecting signature shares...");
    let mut signature_shares: BTreeMap<u16, String> = BTreeMap::new();

    for url in cli.signer_urls.iter().take(threshold) {
        let request = Round2Request {
            session_id: session_id.clone(),
            sighash: sighash_hex.clone(),
            tweak: None, // No tweak - address uses raw internal key
            commitments: commitments.clone(),
            identifier_map: identifier_map.clone(),
        };

        let response: Round2Response = post_json(&client, &format!("{}/round2", url), &request, &api_key)?
            .json()?;

        println!("  Signer {}: OK", response.signer_id);
        signature_shares.insert(response.signer_id, response.signature_share);
    }

    // Step 5: Aggregate signatures
    println!("\n=== Step 5: Aggregating signature ===\n");

    let aggregate_request = AggregateRequest {
        commitments: commitments.clone(),
        identifier_map: identifier_map.clone(),
        signature_shares,
        sighash: sighash_hex.clone(),
    };

    let aggregate_response: AggregateResponse = post_json(
        &client,
        &format!("{}/aggregate", cli.signer_urls[0]),
        &aggregate_request,
        &api_key,
    )?
    .json()?;

    println!(
        "Signature: {}...",
        &aggregate_response.signature[..32]
    );
    println!("Group Key: {}", aggregate_response.group_public_key);

    // Step 6: Attach signature to transaction
    println!("\n=== Step 6: Building signed transaction ===\n");

    let sig_bytes = hex::decode(&aggregate_response.signature)?;
    let schnorr_sig = SchnorrSignature::from_slice(&sig_bytes)?;
    let taproot_sig = TaprootSignature {
        signature: schnorr_sig,
        sighash_type: TapSighashType::Default,
    };

    // Build witness
    tx.input[0].witness.push(taproot_sig.to_vec());

    let signed_tx_hex = serialize_hex(&tx);
    println!("Signed transaction hex:");
    println!("{}", signed_tx_hex);

    if cli.dry_run {
        println!("\n=== Dry run — skipping broadcast ===\n");
    } else {
        // Step 7: Broadcast transaction
        println!("\n=== Step 7: Broadcasting transaction ===\n");

        let broadcast_response = client
            .post(format!("{}/tx", cli.esplora_api))
            .body(signed_tx_hex.clone())
            .send()?;

        if broadcast_response.status().is_success() {
            let new_txid = broadcast_response.text()?;
            println!("Transaction broadcast successfully!");
            println!("New TXID: {}", new_txid);
            println!("\nView on explorer:");
            println!("https://mempool.space/testnet/tx/{}", new_txid);
        } else {
            let error_text = broadcast_response.text()?;
            println!("Broadcast failed: {}", error_text);
            println!("\nSigned transaction (for manual broadcast):");
            println!("{}", signed_tx_hex);
        }
    }

    println!("\n╔════════════════════════════════════════════════════════════╗");
    println!("║              FROST Sweep Complete                          ║");
    println!("╚════════════════════════════════════════════════════════════╝");

    Ok(())
}
