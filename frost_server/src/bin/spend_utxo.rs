//! FROST Threshold Spending - Sweep UTXO with 2-of-3 threshold signature
//!
//! This binary:
//! 1. Builds a proper BIP-341 Taproot sighash
//! 2. Collects FROST signature shares from threshold signers
//! 3. Aggregates shares into a valid Schnorr signature via /aggregate endpoint
//! 4. Broadcasts the signed transaction to Bitcoin testnet
//!
//! Usage: cargo run --bin spend_utxo
//!
//! Test UTXO (Bitcoin Testnet):
//! - TXID: b548a007f3f9b5df71c8558a3040f37e3a5734d810d4eb021fe4a57bedcd2334
//! - VOUT: 0
//! - Amount: 10,000 sats
//! - Address: tb1puxc4wpqy03f7mr6qw7rcnkvhu7ffft3k3afnynlmerjdlxajm7ks9js58n

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

// UTXO to spend (from the testnet deposit)
const UTXO_TXID: &str = "b548a007f3f9b5df71c8558a3040f37e3a5734d810d4eb021fe4a57bedcd2334";
const UTXO_VOUT: u32 = 0;
const UTXO_AMOUNT: u64 = 10_000; // satoshis

// Group public key from DKG
const GROUP_PUBKEY: &str = "e1b15704047c53ed8f40778789d997e79294ae368f53324ffbc8e4df9bb2dfad";

// Destination address (sending back to original sender)
const DESTINATION: &str = "tb1p3e44guscrytuum9q36tlx5kez9zvdheuwxlq9k9y4kud3hyckhtq63fz34";

// Fee in satoshis (reasonable for testnet)
const FEE: u64 = 200;

// Esplora API for broadcasting
const ESPLORA_API: &str = "https://blockstream.info/testnet/api";

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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("╔════════════════════════════════════════════════════════════╗");
    println!("║     FROST Threshold Sweep - Real Bitcoin Transaction       ║");
    println!("╚════════════════════════════════════════════════════════════╝\n");

    let secp = Secp256k1::new();
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    // Parse group public key
    let group_pubkey_bytes = hex::decode(GROUP_PUBKEY)?;
    let group_pubkey = XOnlyPublicKey::from_slice(&group_pubkey_bytes)?;

    println!("UTXO to sweep:");
    println!("  TXID: {}", UTXO_TXID);
    println!("  VOUT: {}", UTXO_VOUT);
    println!("  Amount: {} sats", UTXO_AMOUNT);
    println!("  Group Pubkey: {}", GROUP_PUBKEY);

    println!("\nDestination: {}", DESTINATION);
    println!("Fee: {} sats", FEE);
    println!("Output: {} sats", UTXO_AMOUNT - FEE);

    // Step 1: Check UTXO still exists
    println!("\n=== Step 1: Verifying UTXO exists ===\n");

    let utxo_check: serde_json::Value = client
        .get(format!("{}/tx/{}", ESPLORA_API, UTXO_TXID))
        .send()?
        .json()?;

    let status = utxo_check.get("status").and_then(|s| s.get("confirmed"));
    if status == Some(&serde_json::Value::Bool(true)) {
        println!("UTXO confirmed on-chain");
    } else {
        println!("WARNING: UTXO may not be confirmed");
    }

    // Step 2: Build unsigned transaction
    println!("\n=== Step 2: Building unsigned transaction ===\n");

    let txid = Txid::from_str(UTXO_TXID)?;
    let outpoint = OutPoint::new(txid, UTXO_VOUT);

    // Parse destination address
    let dest_address = Address::from_str(DESTINATION)?.require_network(Network::Testnet)?;

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
            value: Amount::from_sat(UTXO_AMOUNT - FEE),
            script_pubkey: dest_address.script_pubkey(),
        }],
    };

    println!("Transaction built:");
    println!("  Input: {}:{}", UTXO_TXID, UTXO_VOUT);
    println!("  Output: {} sats to {}", UTXO_AMOUNT - FEE, DESTINATION);

    // Step 3: Compute BIP-341 Taproot sighash
    println!("\n=== Step 3: Computing BIP-341 sighash ===\n");

    // The deposit address was created with raw internal key as output key (no tweak)
    // So we use TweakedPublicKey::dangerous_assume_tweaked to create the prevout script
    use bitcoin::key::TweakedPublicKey;
    let tweaked_pubkey = TweakedPublicKey::dangerous_assume_tweaked(group_pubkey);
    let prevout_script = ScriptBuf::new_p2tr_tweaked(tweaked_pubkey);
    let prevout = TxOut {
        value: Amount::from_sat(UTXO_AMOUNT),
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

    // Step 4: FROST 2-of-3 signing
    println!("\n=== Step 4: FROST 2-of-3 signing ===\n");

    let session_id = uuid::Uuid::new_v4().to_string();
    println!("Session: {}", session_id);

    // Round 1: Collect commitments (no tweak - deposit address uses raw internal key)
    println!("\nRound 1: Collecting commitments...");
    let mut commitments: BTreeMap<u16, String> = BTreeMap::new();
    let mut identifier_map: BTreeMap<u16, String> = BTreeMap::new();

    for url in SIGNER_URLS.iter().take(2) {
        let request = Round1Request {
            session_id: session_id.clone(),
            sighash: sighash_hex.clone(),
            tweak: None, // No tweak - address uses raw internal key
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

    // Round 2: Collect signature shares (no tweak - deposit address uses raw internal key)
    println!("\nRound 2: Collecting signature shares...");
    let mut signature_shares: BTreeMap<u16, String> = BTreeMap::new();

    for url in SIGNER_URLS.iter().take(2) {
        let request = Round2Request {
            session_id: session_id.clone(),
            sighash: sighash_hex.clone(),
            tweak: None, // No tweak - address uses raw internal key
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

    // Step 5: Aggregate signatures
    println!("\n=== Step 5: Aggregating signature ===\n");

    let aggregate_request = AggregateRequest {
        commitments: commitments.clone(),
        identifier_map: identifier_map.clone(),
        signature_shares,
        sighash: sighash_hex.clone(),
    };

    let aggregate_response: AggregateResponse = client
        .post(format!("{}/aggregate", SIGNER_URLS[0]))
        .json(&aggregate_request)
        .send()?
        .json()?;

    println!("Signature: {}...", &aggregate_response.signature[..32]);
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

    // Step 7: Broadcast transaction
    println!("\n=== Step 7: Broadcasting transaction ===\n");

    let broadcast_response = client
        .post(format!("{}/tx", ESPLORA_API))
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

    println!("\n╔════════════════════════════════════════════════════════════╗");
    println!("║              FROST Sweep Complete                          ║");
    println!("╚════════════════════════════════════════════════════════════╝");

    Ok(())
}
