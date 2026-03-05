//! FROST Sweep Integration Test
//!
//! Tests the exact code path in UtxoSweeper::sweep_utxo with FROST signing:
//! 1. Creates a tweaked deposit address using the FROST group pubkey + commitment
//! 2. Funds it on regtest
//! 3. Calls sweep_utxo which signs with FROST
//! 4. Verifies the sweep tx is confirmed on regtest
//!
//! Prerequisites:
//!   - Docker regtest running (docker compose -f docker-compose.regtest.yml up -d)
//!   - FROST signers running (cd frost_server && docker compose up -d)
//!
//! Usage: cargo run --bin test_frost_sweep

use bitcoin::XOnlyPublicKey;
use sha2::{Digest, Sha256};
use zbtc::deposit_tracker::sweeper::UtxoSweeper;
use zbtc::frost_client::FrostClient;

const ESPLORA_URL: &str = "http://localhost:3000/regtest/api";
const SIGNER_URLS: &[&str] = &["http://localhost:9001", "http://localhost:9002"];
const GROUP_PUBKEY_HEX: &str = "d11184211f11afe88cd40e242988d428ee5d18716f15da6286b1fd5a2f694c66";
const POOL_RECEIVE_ADDRESS: &str = "bcrt1p7gtwc7tkqp3la9y4a33q7pzt854d95s550rzvds60ajnl2pfmvzqc72yl0";

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// Compute taproot tweak: H_taptweak(P || commitment)
fn compute_tweak(internal_key: &XOnlyPublicKey, commitment: &[u8; 32]) -> [u8; 32] {
    let tag_hash = sha256(b"TapTweak");
    let mut hasher = Sha256::new();
    hasher.update(tag_hash);
    hasher.update(tag_hash);
    hasher.update(internal_key.serialize());
    hasher.update(commitment);
    hasher.finalize().into()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("╔═══════════════════════════════════════════════════════════════╗");
    println!("║     FROST Sweep Integration Test — UtxoSweeper E2E          ║");
    println!("╚═══════════════════════════════════════════════════════════════╝");
    println!();

    // Step 1: Create FROST client and sweeper
    println!("[Step 1] Creating FROST sweeper...");
    let group_pubkey_bytes = hex::decode(GROUP_PUBKEY_HEX)?;
    let group_pubkey = XOnlyPublicKey::from_slice(&group_pubkey_bytes)?;

    let frost_client = FrostClient::new(
        SIGNER_URLS.iter().map(|s| s.to_string()).collect(),
        2, // threshold
        None, // no API key
    );

    let sweeper = UtxoSweeper::from_frost_with_esplora(
        frost_client,
        group_pubkey,
        POOL_RECEIVE_ADDRESS.to_string(),
        bitcoin::Network::Regtest,
        Some(ESPLORA_URL),
    );

    println!("  Pool pubkey: {}", sweeper.pool_public_key());
    println!("  Pool receive: {}", POOL_RECEIVE_ADDRESS);

    // Step 2: Generate a commitment and tweaked deposit address
    println!("\n[Step 2] Generating deposit address...");
    let commitment: [u8; 32] = sha256(b"frost_sweep_e2e_test_commitment");
    let commitment_hex = hex::encode(commitment);
    println!("  Commitment: {}", commitment_hex);

    // Compute tweaked deposit address
    let secp = bitcoin::secp256k1::Secp256k1::new();
    let tweak = compute_tweak(&group_pubkey, &commitment);
    let scalar = bitcoin::secp256k1::Scalar::from_be_bytes(tweak)
        .map_err(|_| "invalid tweak scalar")?;
    let (tweaked_pubkey, _parity) = group_pubkey.add_tweak(&secp, &scalar)?;
    let deposit_address = bitcoin::Address::p2tr_tweaked(
        bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(tweaked_pubkey),
        bitcoin::Network::Regtest,
    );
    let deposit_addr_str = deposit_address.to_string();
    println!("  Deposit address: {}", deposit_addr_str);

    // Step 3: Fund the deposit address on regtest
    println!("\n[Step 3] Funding deposit address on regtest...");
    let client = reqwest::Client::new();

    // Use bitcoin-cli via docker to fund the address
    let fund_output = std::process::Command::new("docker")
        .args([
            "exec", "aegis-esplora-regtest",
            "/srv/explorer/bitcoin/bin/bitcoin-cli",
            "-regtest", "-datadir=/data/bitcoin", "-rpcwallet=test",
            "sendtoaddress", &deposit_addr_str, "0.0005",
        ])
        .output()?;

    if !fund_output.status.success() {
        return Err(format!("Failed to fund address: {}", String::from_utf8_lossy(&fund_output.stderr)).into());
    }
    let fund_txid = String::from_utf8(fund_output.stdout)?.trim().to_string();
    println!("  Funding txid: {}", fund_txid);

    // Mine 1 block
    let mine_output = std::process::Command::new("docker")
        .args([
            "exec", "aegis-esplora-regtest",
            "/srv/explorer/bitcoin/bin/bitcoin-cli",
            "-regtest", "-datadir=/data/bitcoin", "-rpcwallet=test",
            "generatetoaddress", "1", POOL_RECEIVE_ADDRESS,
        ])
        .output()?;
    if !mine_output.status.success() {
        return Err(format!("Failed to mine: {}", String::from_utf8_lossy(&mine_output.stderr)).into());
    }
    println!("  Mined 1 confirmation block");

    // Wait for Esplora to index
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // Verify UTXO exists
    let utxo_url = format!("{}/address/{}/utxo", ESPLORA_URL, deposit_addr_str);
    let utxos: serde_json::Value = client.get(&utxo_url).send().await?.json().await?;
    println!("  UTXOs at deposit address: {}", utxos);
    if utxos.as_array().map(|a| a.is_empty()).unwrap_or(true) {
        return Err("No UTXOs found at deposit address".into());
    }

    // Step 4: Sweep with FROST!
    println!("\n[Step 4] Sweeping UTXO with FROST threshold signing...");
    let sweep_result = sweeper.sweep_utxo(
        &deposit_addr_str,
        &commitment_hex,
        1, // required confirmations
    ).await;

    match sweep_result {
        Ok(result) => {
            println!("  SWEEP SUCCEEDED!");
            println!("  Sweep txid: {}", result.txid);
            println!("  Amount: {} sats", result.amount_sats);
            println!("  Fee: {} sats", result.fee_sats);
            println!("  Pool address: {}", result.pool_address);

            // Mine another block to confirm the sweep
            let _ = std::process::Command::new("docker")
                .args([
                    "exec", "aegis-esplora-regtest",
                    "/srv/explorer/bitcoin/bin/bitcoin-cli",
                    "-regtest", "-datadir=/data/bitcoin", "-rpcwallet=test",
                    "generatetoaddress", "1", POOL_RECEIVE_ADDRESS,
                ])
                .output()?;
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;

            // Verify sweep tx is confirmed
            let tx_url = format!("{}/tx/{}", ESPLORA_URL, result.txid);
            let tx_info: serde_json::Value = client.get(&tx_url).send().await?.json().await?;
            let confirmed = tx_info["status"]["confirmed"].as_bool().unwrap_or(false);
            println!("  Sweep tx confirmed: {}", confirmed);

            if !confirmed {
                return Err("Sweep tx not confirmed!".into());
            }

            println!("\n╔═══════════════════════════════════════════════════╗");
            println!("║  FROST SWEEP E2E TEST PASSED!                     ║");
            println!("╚═══════════════════════════════════════════════════╝");
            Ok(())
        }
        Err(e) => {
            eprintln!("\n  SWEEP FAILED: {}", e);
            Err(e.into())
        }
    }
}
