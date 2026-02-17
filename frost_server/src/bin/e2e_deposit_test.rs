//! End-to-End Deposit Test with FROST + SPV Verification
//!
//! This binary tests the full deposit flow:
//! 1. Generate dual-path Taproot deposit address (FROST + user refund)
//! 2. Wait for user to deposit BTC
//! 3. Sweep via FROST 2-of-3 threshold signing
//! 4. Generate SPV proof for verification
//!
//! Usage:
//!   cargo run --bin e2e_deposit_test -- --user-pubkey <32-byte-hex>
//!   cargo run --bin e2e_deposit_test -- --generate-keypair  # Generate test keypair

use bitcoin::consensus::encode::serialize_hex;
use bitcoin::hashes::Hash;
use bitcoin::key::{Keypair, Secp256k1};
use bitcoin::opcodes::all::*;
use bitcoin::script::Builder as ScriptBuilder;
use bitcoin::secp256k1::schnorr::Signature as SchnorrSignature;
use bitcoin::sighash::{Prevouts, SighashCache, TapSighashType};
use bitcoin::taproot::{LeafVersion, TaprootBuilder, Signature as TaprootSignature};
use bitcoin::{
    absolute, transaction, Address, Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction,
    TxIn, TxOut, Txid, Witness, XOnlyPublicKey,
};
use clap::Parser;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::str::FromStr;

// FROST signer URLs
const SIGNER_URLS: [&str; 3] = [
    "http://localhost:9001",
    "http://localhost:9002",
    "http://localhost:9003",
];

// FROST group public key from DKG
const FROST_GROUP_PUBKEY: &str = "e1b15704047c53ed8f40778789d997e79294ae368f53324ffbc8e4df9bb2dfad";

// Timelock for refund path
const TIMELOCK_BLOCKS: u16 = 6;

// Esplora API for Bitcoin testnet
const ESPLORA_API: &str = "https://blockstream.info/testnet/api";

#[derive(Parser)]
#[command(name = "e2e_deposit_test")]
#[command(about = "End-to-end deposit test with FROST threshold signing and SPV verification")]
struct Args {
    /// User's x-only public key (32 bytes hex) for refund path
    #[arg(short, long)]
    user_pubkey: Option<String>,

    /// Generate a test keypair for the user
    #[arg(long)]
    generate_keypair: bool,

    /// Destination address for sweep (default: back to sender for testing)
    #[arg(short, long)]
    destination: Option<String>,

    /// Skip deposit wait (use existing UTXO)
    #[arg(long)]
    txid: Option<String>,

    /// Output index of existing UTXO
    #[arg(long, default_value = "0")]
    vout: u32,

    /// Amount in satoshis (required if using --txid)
    #[arg(long)]
    amount: Option<u64>,
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
}

#[derive(Debug, Deserialize)]
struct AggregateResponse {
    signature: String,
    group_public_key: String,
}

#[derive(Debug, Deserialize)]
struct EsploraUtxo {
    txid: String,
    vout: u32,
    value: u64,
    status: EsploraStatus,
}

#[derive(Debug, Deserialize)]
struct EsploraStatus {
    confirmed: bool,
    block_height: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct EsploraTx {
    txid: String,
    status: EsploraStatus,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let secp = Secp256k1::new();
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    println!("{}",
        r#"
╔════════════════════════════════════════════════════════════════════╗
║      zVault E2E Deposit Test - FROST + SPV Verification            ║
╚════════════════════════════════════════════════════════════════════╝
"#);

    // Step 1: Get or generate user keypair
    let (user_secret, user_pubkey) = if args.generate_keypair {
        println!("Generating test keypair for user...\n");
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed)?;
        let secret = bitcoin::secp256k1::SecretKey::from_slice(&seed)?;
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (pubkey, _) = keypair.x_only_public_key();
        println!("  User Secret Key: {} (SAVE THIS!)", hex::encode(seed));
        println!("  User Public Key: {}", hex::encode(pubkey.serialize()));
        (Some(secret), pubkey)
    } else if let Some(pubkey_hex) = &args.user_pubkey {
        let pubkey_bytes = hex::decode(pubkey_hex)?;
        if pubkey_bytes.len() != 32 {
            return Err(format!("User pubkey must be 32 bytes, got {}", pubkey_bytes.len()).into());
        }
        let pubkey = XOnlyPublicKey::from_slice(&pubkey_bytes)?;
        println!("Using provided user public key: {}", pubkey_hex);
        (None, pubkey)
    } else {
        return Err("Please provide --user-pubkey or use --generate-keypair".into());
    };

    // Step 2: Parse FROST group key
    let frost_pubkey_bytes = hex::decode(FROST_GROUP_PUBKEY)?;
    let frost_pubkey = XOnlyPublicKey::from_slice(&frost_pubkey_bytes)?;

    // Step 3: Generate commitment (random for unique address)
    let mut commitment = [0u8; 32];
    getrandom::getrandom(&mut commitment)?;

    // Step 4: Build dual-path Taproot address
    println!("\n=== Step 1: Generating Dual-Path Deposit Address ===\n");

    // Build refund script: <user_pubkey> OP_CHECKSIGVERIFY <timelock> OP_CSV
    let refund_script = ScriptBuilder::new()
        .push_x_only_key(&user_pubkey)
        .push_opcode(OP_CHECKSIGVERIFY)
        .push_int(TIMELOCK_BLOCKS as i64)
        .push_opcode(OP_CSV)
        .into_script();

    println!("Refund Script (user can reclaim after {} blocks):", TIMELOCK_BLOCKS);
    println!("  ASM: {}", refund_script.to_asm_string());

    // Build Taproot tree with refund script as leaf
    let builder = TaprootBuilder::new()
        .add_leaf(0, refund_script.clone())
        .expect("Failed to add leaf");

    // Finalize with FROST group key as internal key
    let taproot_spend_info = builder
        .finalize(&secp, frost_pubkey)
        .expect("Failed to finalize taproot");

    let output_key = taproot_spend_info.output_key();

    // Apply commitment tweak for unique address
    let commitment_tweak = compute_commitment_tweak(&output_key.to_x_only_public_key(), &commitment);
    let scalar = bitcoin::secp256k1::Scalar::from_be_bytes(commitment_tweak)?;

    let (final_output_key, _parity) = output_key
        .to_x_only_public_key()
        .add_tweak(&secp, &scalar)?;

    // Create deposit address
    let deposit_address = Address::p2tr_tweaked(
        bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(final_output_key),
        Network::Testnet,
    );

    println!("\nDeposit Address: {}", deposit_address);
    println!("FROST Group Key: {}", FROST_GROUP_PUBKEY);
    println!("Commitment: {}", hex::encode(&commitment));
    println!("\nSpending Paths:");
    println!("  1. KEY PATH: FROST 2-of-3 can sweep immediately");
    println!("  2. SCRIPT PATH: User can refund after {} blocks (~1 hour)", TIMELOCK_BLOCKS);

    // Step 5: Wait for deposit or use existing UTXO
    let (utxo_txid, utxo_vout, utxo_amount) = if let Some(txid) = args.txid {
        let amount = args.amount.ok_or("--amount required when using --txid")?;
        println!("\n=== Using Existing UTXO ===");
        println!("  TXID: {}", txid);
        println!("  VOUT: {}", args.vout);
        println!("  Amount: {} sats", amount);
        (txid, args.vout, amount)
    } else {
        println!("\n=== Step 2: Waiting for Deposit ===\n");
        println!("Please send testnet BTC to: {}", deposit_address);
        println!("Minimum recommended: 10,000 sats (0.0001 BTC)");
        println!("\nPolling for deposit... (Press Ctrl+C to cancel)");

        loop {
            let url = format!("{}/address/{}/utxo", ESPLORA_API, deposit_address);
            let utxos: Vec<EsploraUtxo> = client.get(&url).send()?.json()?;

            if let Some(utxo) = utxos.first() {
                if utxo.status.confirmed {
                    println!("\nDeposit confirmed!");
                    println!("  TXID: {}", utxo.txid);
                    println!("  Amount: {} sats", utxo.value);
                    println!("  Block: {:?}", utxo.status.block_height);
                    break (utxo.txid.clone(), utxo.vout, utxo.value);
                } else {
                    print!("\rDeposit detected (unconfirmed)... waiting for confirmation");
                    io::stdout().flush()?;
                }
            } else {
                print!("\rWaiting for deposit...");
                io::stdout().flush()?;
            }

            std::thread::sleep(std::time::Duration::from_secs(10));
        }
    };

    // Step 6: Build sweep transaction
    println!("\n=== Step 3: Building Sweep Transaction ===\n");

    let destination = if let Some(dest) = args.destination {
        Address::from_str(&dest)?.require_network(Network::Testnet)?
    } else {
        // Default: send back to a simple FROST-controlled address (no script path)
        // This simulates sweeping to the pool
        let pool_address = Address::p2tr_tweaked(
            bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(frost_pubkey),
            Network::Testnet,
        );
        println!("Using FROST pool as destination (no --destination provided)");
        pool_address
    };

    let fee = 200u64; // Simple fee for testnet
    let send_amount = utxo_amount.saturating_sub(fee);

    if send_amount < 546 {
        return Err("Amount too small after fees".into());
    }

    println!("Sweep Details:");
    println!("  From: {}", deposit_address);
    println!("  To: {}", destination);
    println!("  Amount: {} sats", send_amount);
    println!("  Fee: {} sats", fee);

    let txid = Txid::from_str(&utxo_txid)?;
    let outpoint = OutPoint::new(txid, utxo_vout);

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
            script_pubkey: destination.script_pubkey(),
        }],
    };

    // Step 7: Compute sighash
    println!("\n=== Step 4: Computing BIP-341 Sighash ===\n");

    // For key path spending with Taproot tree, we need the merkle root
    let merkle_root = taproot_spend_info.merkle_root();

    // The prevout uses the final tweaked output key
    let prevout_script = ScriptBuf::new_p2tr_tweaked(
        bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(final_output_key),
    );
    let prevout = TxOut {
        value: Amount::from_sat(utxo_amount),
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

    // Step 8: FROST 2-of-3 signing with tweak
    println!("\n=== Step 5: FROST 2-of-3 Threshold Signing ===\n");

    // Check signers are healthy
    for (i, url) in SIGNER_URLS.iter().enumerate() {
        match client.get(format!("{}/health", url)).send() {
            Ok(resp) if resp.status().is_success() => {
                println!("  Signer {} at {}: OK", i + 1, url);
            }
            _ => {
                return Err(format!("Signer {} at {} is not responding", i + 1, url).into());
            }
        }
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    println!("\nSession: {}", session_id);

    // For key-path spending with a Taproot tree, we need to apply the full tweak:
    // 1. First, the internal key is tweaked with the merkle root (standard BIP-341)
    // 2. Then, we applied an additional commitment tweak
    //
    // The FROST signers need to sign with both tweaks combined
    // Combined tweak = hash(output_key || commitment_tweak_data)

    // Calculate the full tweak that transforms frost_pubkey to final_output_key
    // This includes: BIP-341 taptweak + commitment tweak
    let full_tweak = compute_full_tweak(&frost_pubkey, merkle_root.as_ref(), &commitment);
    let tweak_hex = Some(hex::encode(&full_tweak));

    // Round 1: Collect commitments
    println!("\nRound 1: Collecting commitments...");
    let mut commitments: BTreeMap<u16, String> = BTreeMap::new();
    let mut identifier_map: BTreeMap<u16, String> = BTreeMap::new();

    for url in SIGNER_URLS.iter().take(2) {
        let request = Round1Request {
            session_id: session_id.clone(),
            sighash: sighash_hex.clone(),
            tweak: tweak_hex.clone(),
        };

        let response: Round1Response = client
            .post(format!("{}/round1", url))
            .json(&request)
            .send()?
            .json()?;

        println!("  Signer {}: commitment received", response.signer_id);
        commitments.insert(response.signer_id, response.commitment);
        identifier_map.insert(response.signer_id, response.frost_identifier);
    }

    // Round 2: Collect signature shares
    println!("\nRound 2: Collecting signature shares...");
    let mut signature_shares: BTreeMap<u16, String> = BTreeMap::new();

    for url in SIGNER_URLS.iter().take(2) {
        let request = Round2Request {
            session_id: session_id.clone(),
            sighash: sighash_hex.clone(),
            tweak: tweak_hex.clone(),
            commitments: commitments.clone(),
            identifier_map: identifier_map.clone(),
        };

        let response: Round2Response = client
            .post(format!("{}/round2", url))
            .json(&request)
            .send()?
            .json()?;

        println!("  Signer {}: share received", response.signer_id);
        signature_shares.insert(response.signer_id, response.signature_share);
    }

    // Aggregate signatures
    println!("\nAggregating signature...");

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

    // Step 9: Attach signature and broadcast
    println!("\n=== Step 6: Broadcasting Transaction ===\n");

    let sig_bytes = hex::decode(&aggregate_response.signature)?;
    let schnorr_sig = SchnorrSignature::from_slice(&sig_bytes)?;
    let taproot_sig = TaprootSignature {
        signature: schnorr_sig,
        sighash_type: TapSighashType::Default,
    };

    tx.input[0].witness.push(taproot_sig.to_vec());

    let signed_tx_hex = serialize_hex(&tx);
    println!("Signed TX: {}...{}", &signed_tx_hex[..40], &signed_tx_hex[signed_tx_hex.len()-40..]);

    // Broadcast
    let broadcast_response = client
        .post(format!("{}/tx", ESPLORA_API))
        .body(signed_tx_hex.clone())
        .send()?;

    if broadcast_response.status().is_success() {
        let new_txid = broadcast_response.text()?;
        println!("\nTransaction broadcast successfully!");
        println!("TXID: {}", new_txid);
        println!("\nView on explorer:");
        println!("  https://mempool.space/testnet/tx/{}", new_txid);

        // Step 10: Generate SPV proof data
        println!("\n=== Step 7: SPV Proof Data (for Solana verification) ===\n");
        println!("Wait for 1+ confirmations, then use this data for SPV verification:");
        println!("  Sweep TXID: {}", new_txid);
        println!("  Amount: {} sats", send_amount);
        println!("  Output Index: 0");
        println!("\nTo verify on Solana:");
        println!("  1. Ensure BTC light client has the block header");
        println!("  2. Fetch merkle proof from Esplora: GET {}/tx/{}/merkle-proof", ESPLORA_API, new_txid);
        println!("  3. Call verify_deposit instruction with proof data");
    } else {
        let error_text = broadcast_response.text()?;
        println!("\nBroadcast failed: {}", error_text);
        println!("\nSigned transaction (for manual broadcast):");
        println!("{}", signed_tx_hex);
    }

    println!("\n{}",
        r#"
╔════════════════════════════════════════════════════════════════════╗
║                     E2E Test Complete                              ║
╚════════════════════════════════════════════════════════════════════╝
"#);

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

/// Compute full tweak for FROST signing (BIP-341 taptweak + commitment tweak)
fn compute_full_tweak(
    internal_key: &XOnlyPublicKey,
    merkle_root: Option<&bitcoin::taproot::TapNodeHash>,
    commitment: &[u8; 32],
) -> [u8; 32] {
    // Step 1: Compute BIP-341 taptweak
    let tap_tag = Sha256::digest(b"TapTweak");

    let mut tap_hasher = Sha256::new();
    tap_hasher.update(&tap_tag);
    tap_hasher.update(&tap_tag);
    tap_hasher.update(&internal_key.serialize());
    if let Some(root) = merkle_root {
        use bitcoin::hashes::Hash;
        tap_hasher.update(root.to_byte_array());
    }
    let taptweak: [u8; 32] = tap_hasher.finalize().into();

    // Step 2: Apply taptweak to get output_key
    let secp = Secp256k1::new();
    let scalar = bitcoin::secp256k1::Scalar::from_be_bytes(taptweak)
        .expect("Invalid taptweak scalar");
    let (output_key, _) = internal_key
        .add_tweak(&secp, &scalar)
        .expect("Taptweak failed");

    // Step 3: Compute commitment tweak on output_key
    let commit_tag = Sha256::digest(b"zVault/CommitmentTweak");

    let mut commit_hasher = Sha256::new();
    commit_hasher.update(&commit_tag);
    commit_hasher.update(&commit_tag);
    commit_hasher.update(&output_key.serialize());
    commit_hasher.update(commitment);
    let commitment_tweak: [u8; 32] = commit_hasher.finalize().into();

    // Step 4: Combine tweaks (add scalars mod order)
    // For FROST, we need the total tweak from internal_key to final_output_key
    // total_tweak = taptweak + commitment_tweak (mod n)
    use bitcoin::secp256k1::Scalar;

    let tap_scalar = Scalar::from_be_bytes(taptweak).expect("Invalid tap scalar");
    let commit_scalar = Scalar::from_be_bytes(commitment_tweak).expect("Invalid commit scalar");

    // Add the two scalars
    let combined = add_scalars(&tap_scalar, &commit_scalar);

    combined
}

/// Add two secp256k1 scalars (mod n)
fn add_scalars(a: &bitcoin::secp256k1::Scalar, b: &bitcoin::secp256k1::Scalar) -> [u8; 32] {
    // Convert to big integers, add, reduce mod n
    // For simplicity, we'll use the fact that secp256k1 scalar addition
    // can be done by creating a dummy point and using EC operations

    // Actually, we can use the negate and add pattern
    // But the simplest is to just return both tweaks separately
    // and let FROST handle them...

    // For now, let's use a simpler approach:
    // We'll compute the combined tweak by doing the math manually
    let a_bytes = a.to_be_bytes();
    let b_bytes = b.to_be_bytes();

    // Add as big integers mod n (secp256k1 order)
    let n = [
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE,
        0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B,
        0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41,
    ];

    // Simple addition with carry
    let mut result = [0u8; 32];
    let mut carry: u16 = 0;

    for i in (0..32).rev() {
        let sum = a_bytes[i] as u16 + b_bytes[i] as u16 + carry;
        result[i] = sum as u8;
        carry = sum >> 8;
    }

    // Reduce mod n if necessary (simple check: if result >= n, subtract n)
    if result >= n {
        let mut borrow: i16 = 0;
        for i in (0..32).rev() {
            let diff = result[i] as i16 - n[i] as i16 - borrow;
            if diff < 0 {
                result[i] = (diff + 256) as u8;
                borrow = 1;
            } else {
                result[i] = diff as u8;
                borrow = 0;
            }
        }
    }

    result
}
