//! FROST Redemption Integration Test
//!
//! Tests the MpcSigner for BTC withdrawals:
//! 1. Uses the pool's UTXO (from previous sweep test)
//! 2. Builds a withdrawal transaction
//! 3. Signs with MpcSigner → FrostClient → FROST signers
//! 4. Broadcasts and verifies on regtest
//!
//! Prerequisites:
//!   - Docker regtest running
//!   - FROST signers running
//!   - Pool address has UTXOs (run test_frost_sweep first)
//!
//! Usage: cargo run --bin test_frost_redemption

use bitcoin::{TapTweakHash, XOnlyPublicKey};
use zbtc::frost_client::FrostClient;
use zbtc::redemption::builder::{TxBuilder};
use zbtc::redemption::signer::{MpcSigner, TxSigner};
use zbtc::redemption::types::{PoolUtxo, WithdrawalRequest};

const ESPLORA_URL: &str = "http://localhost:3000/regtest/api";
const SIGNER_URLS: &[&str] = &["http://localhost:9001", "http://localhost:9002"];
const GROUP_PUBKEY_HEX: &str = "d11184211f11afe88cd40e242988d428ee5d18716f15da6286b1fd5a2f694c66";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("╔═══════════════════════════════════════════════════════════════╗");
    println!("║     FROST Redemption Test — MpcSigner E2E                   ║");
    println!("╚═══════════════════════════════════════════════════════════════╝");
    println!();

    // Step 1: Compute proper BIP-341 tweaked pool address and fund it
    println!("[Step 1] Creating BIP-341 tweaked pool address...");
    let client = reqwest::Client::new();
    let group_pubkey_bytes = hex::decode(GROUP_PUBKEY_HEX)?;
    let group_pubkey = XOnlyPublicKey::from_slice(&group_pubkey_bytes)?;

    // MpcSigner uses TapTweakHash::from_key_and_tweak(P, None) — standard BIP-341
    let secp = bitcoin::secp256k1::Secp256k1::new();
    let tweak = TapTweakHash::from_key_and_tweak(group_pubkey, None);
    let (tweaked_pubkey, _parity) = group_pubkey.add_tweak(&secp, &tweak.to_scalar())?;
    let pool_address = bitcoin::Address::p2tr_tweaked(
        bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(tweaked_pubkey),
        bitcoin::Network::Regtest,
    );
    let pool_addr_str = pool_address.to_string();
    println!("  Internal key: {}", GROUP_PUBKEY_HEX);
    println!("  Tweaked output key: {}", hex::encode(tweaked_pubkey.serialize()));
    println!("  Pool address (BIP-341): {}", pool_addr_str);

    // Fund this address
    println!("  Funding pool address...");
    let fund_output = std::process::Command::new("docker")
        .args([
            "exec", "aegis-esplora-regtest",
            "/srv/explorer/bitcoin/bin/bitcoin-cli",
            "-regtest", "-datadir=/data/bitcoin", "-rpcwallet=test",
            "sendtoaddress", &pool_addr_str, "0.001",
        ])
        .output()?;
    if !fund_output.status.success() {
        return Err(format!("Failed to fund: {}", String::from_utf8_lossy(&fund_output.stderr)).into());
    }
    let fund_txid = String::from_utf8(fund_output.stdout)?.trim().to_string();
    println!("  Fund txid: {}", fund_txid);

    // Mine 1 block
    let _ = std::process::Command::new("docker")
        .args([
            "exec", "aegis-esplora-regtest",
            "/srv/explorer/bitcoin/bin/bitcoin-cli",
            "-regtest", "-datadir=/data/bitcoin", "-rpcwallet=test",
            "generatetoaddress", "1", &pool_addr_str,
        ])
        .output()?;
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // Find the UTXO
    let utxo_url = format!("{}/address/{}/utxo", ESPLORA_URL, pool_addr_str);
    let utxos: Vec<serde_json::Value> = client.get(&utxo_url).send().await?.json().await?;
    if utxos.is_empty() {
        return Err("No UTXOs at tweaked pool address".into());
    }

    // Find a non-coinbase UTXO (sendtoaddress output)
    let utxo = utxos.iter().find(|u| u["value"].as_u64().unwrap_or(0) == 100_000)
        .unwrap_or(&utxos[0]);
    let txid = utxo["txid"].as_str().unwrap().to_string();
    let vout = utxo["vout"].as_u64().unwrap() as u32;
    let amount = utxo["value"].as_u64().unwrap();
    println!("  Pool UTXO: {}:{} ({} sats)", &txid[..16], vout, amount);

    // Get the script_pubkey
    let tx_url = format!("{}/tx/{}", ESPLORA_URL, txid);
    let tx_info: serde_json::Value = client.get(&tx_url).send().await?.json().await?;
    let script_pubkey_hex = tx_info["vout"][vout as usize]["scriptpubkey"]
        .as_str()
        .unwrap()
        .to_string();
    println!("  Script pubkey: {}", &script_pubkey_hex);

    // Step 2: Create MpcSigner
    println!("\n[Step 2] Creating MPC signer with FROST...");
    let frost_client = FrostClient::new(
        SIGNER_URLS.iter().map(|s| s.to_string()).collect(),
        2,
        None,
    );

    let signer = MpcSigner::new(frost_client, group_pubkey);
    println!("  Signer type: {}", signer.signer_type());
    println!("  Group pubkey: {}", hex::encode(signer.public_key().serialize()));

    // Step 3: Get a destination address
    println!("\n[Step 3] Getting destination address...");
    let dest_output = std::process::Command::new("docker")
        .args([
            "exec", "aegis-esplora-regtest",
            "/srv/explorer/bitcoin/bin/bitcoin-cli",
            "-regtest", "-datadir=/data/bitcoin", "-rpcwallet=test",
            "getnewaddress", "", "bech32m",
        ])
        .output()?;
    let dest_address = String::from_utf8(dest_output.stdout)?.trim().to_string();
    println!("  Destination: {}", dest_address);

    // Step 4: Build unsigned withdrawal tx
    println!("\n[Step 4] Building withdrawal transaction...");
    let builder = TxBuilder::new(bitcoin::Network::Regtest);

    let pool_utxo = PoolUtxo {
        txid: txid.clone(),
        vout,
        amount_sats: amount,
        script_pubkey: script_pubkey_hex,
    };

    // Builder calculates fee as (10 + 58*inputs + 43*2) * fee_rate = (10 + 58 + 86) * 10 = 1540
    // Use a smaller amount to leave room for fee + change
    let send_amount = amount - 2000; // leave enough for fee
    let withdrawal = WithdrawalRequest::new(
        "test_solana_burn_tx".to_string(),
        "test_solana_address".to_string(),
        send_amount,
        dest_address.clone(),
    );

    let unsigned = builder.build_withdrawal(&withdrawal, &[pool_utxo])?;
    println!("  Tx built: {} inputs, {} outputs", unsigned.tx.input.len(), unsigned.tx.output.len());

    // Step 5: Sign with FROST
    println!("\n[Step 5] Signing with FROST threshold signature...");
    let signed_tx = signer.sign(&unsigned).await?;

    let signed_tx_hex = bitcoin::consensus::encode::serialize_hex(&signed_tx);
    println!("  Signed tx: {} bytes", signed_tx_hex.len() / 2);
    println!("  Witness: {} items", signed_tx.input[0].witness.len());

    // Step 6: Broadcast
    println!("\n[Step 6] Broadcasting signed transaction...");
    let broadcast_response = client
        .post(format!("{}/tx", ESPLORA_URL))
        .body(signed_tx_hex.clone())
        .send()
        .await?;

    if broadcast_response.status().is_success() {
        let new_txid = broadcast_response.text().await?;
        println!("  Broadcast SUCCESS!");
        println!("  Withdrawal txid: {}", new_txid);

        // Mine to confirm
        let _ = std::process::Command::new("docker")
            .args([
                "exec", "aegis-esplora-regtest",
                "/srv/explorer/bitcoin/bin/bitcoin-cli",
                "-regtest", "-datadir=/data/bitcoin", "-rpcwallet=test",
                "generatetoaddress", "1", &pool_addr_str,
            ])
            .output()?;
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let tx_check: serde_json::Value = client
            .get(format!("{}/tx/{}", ESPLORA_URL, new_txid))
            .send().await?
            .json().await?;
        let confirmed = tx_check["status"]["confirmed"].as_bool().unwrap_or(false);
        println!("  Confirmed: {}", confirmed);

        println!("\n╔═══════════════════════════════════════════════════╗");
        println!("║  FROST REDEMPTION E2E TEST PASSED!                ║");
        println!("╚═══════════════════════════════════════════════════╝");
        Ok(())
    } else {
        let error = broadcast_response.text().await?;
        eprintln!("  Broadcast FAILED: {}", error);
        eprintln!("\n  Signed tx hex: {}", &signed_tx_hex[..80]);
        Err(format!("Broadcast failed: {}", error).into())
    }
}
