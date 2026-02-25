//! Mock End-to-End Sweep Test
//!
//! Simulates the full deposit → sweep → FROST sign flow:
//! 1. Generate test keys (trusted dealer)
//! 2. Start 2 FROST signers with policy enforcement
//! 3. Build a taproot deposit address with commitment tweak
//! 4. Build an unsigned sweep transaction
//! 5. Compute sighash + SigningContext
//! 6. Call round1 → verify-commitments → round2 → aggregate via HTTP
//! 7. Verify the final Schnorr signature on the tweaked group pubkey
//!
//! Usage: cargo run --bin mock_sweep_e2e

use bitcoin::{
    absolute::LockTime,
    consensus::encode::{serialize, serialize_hex},
    hashes::Hash,
    key::TweakedPublicKey,
    secp256k1::{self, Message, Secp256k1},
    sighash::{Prevouts, SighashCache, TapSighashType},
    transaction::Version,
    Address, Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid,
    Witness, XOnlyPublicKey,
};
use frost_server::types::*;
use reqwest::Client;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::process::{Child, Command};
use std::time::Duration;

const SIGNER1_URL: &str = "http://localhost:19101";
const SIGNER2_URL: &str = "http://localhost:19102";
const KEY_PASSWORD: &str = "mock_test_password";
const POOL_RECEIVE_ADDR: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("╔═══════════════════════════════════════════════════════════════╗");
    println!("║        MOCK E2E SWEEP TEST — FROST Policy Verification      ║");
    println!("╚═══════════════════════════════════════════════════════════════╝");
    println!();

    // ── Step 1: Generate test keys ──
    println!("[Step 1] Generating 2-of-3 test keys...");
    let key_dir = tempfile::tempdir()?;
    let key_dir_path = key_dir.path().to_str().unwrap().to_string();

    let output = Command::new(std::env::current_exe()?.parent().unwrap().join("frost-server"))
        .args([
            "generate-test-keys",
            "--password", KEY_PASSWORD,
            "--threshold", "2",
            "--total", "3",
            "--output-dir", &key_dir_path,
        ])
        .output()?;

    if !output.status.success() {
        eprintln!("Key generation failed: {}", String::from_utf8_lossy(&output.stderr));
        return Err("Key generation failed".into());
    }

    // Read group public key
    let group_pubkey_hex = std::fs::read_to_string(format!("{}/group_pubkey.txt", key_dir_path))?;
    let group_pubkey_bytes = hex::decode(group_pubkey_hex.trim())?;
    let group_pubkey = XOnlyPublicKey::from_slice(&group_pubkey_bytes)?;
    println!("  Group pubkey: {}", hex::encode(group_pubkey.serialize()));

    // ── Step 2: Start 2 FROST signers with policy ──
    println!("\n[Step 2] Starting 2 FROST signers with policy enforcement...");

    let frost_bin = std::env::current_exe()?.parent().unwrap().join("frost-server");
    let audit_file = format!("{}/audit.jsonl", key_dir_path);

    let mut signer1 = start_signer(&frost_bin, 1, &key_dir_path, "0.0.0.0:19101", &audit_file)?;
    let mut signer2 = start_signer(&frost_bin, 2, &key_dir_path, "0.0.0.0:19102", &audit_file)?;

    // Wait for signers to start
    tokio::time::sleep(Duration::from_secs(3)).await;

    let result = run_sweep_test(group_pubkey).await;

    // ── Cleanup ──
    println!("\n[Cleanup] Stopping signers...");
    let _ = signer1.kill();
    let _ = signer2.kill();

    match result {
        Ok(()) => {
            println!("\n[Audit Log]");
            if let Ok(audit) = std::fs::read_to_string(&audit_file) {
                for line in audit.lines() {
                    println!("  {}", line);
                }
            }
            println!("\n╔═══════════════════════════════════════╗");
            println!("║  ALL TESTS PASSED — SWEEP VERIFIED!   ║");
            println!("╚═══════════════════════════════════════╝");
            Ok(())
        }
        Err(e) => {
            eprintln!("\n  TEST FAILED: {}", e);
            Err(e)
        }
    }
}

async fn run_sweep_test(group_pubkey: XOnlyPublicKey) -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::builder().timeout(Duration::from_secs(10)).build()?;
    let secp = Secp256k1::new();

    // Verify signers are healthy
    for (name, url) in [("Signer 1", SIGNER1_URL), ("Signer 2", SIGNER2_URL)] {
        let health: serde_json::Value = client
            .get(format!("{}/health", url))
            .send().await?
            .json().await?;
        assert_eq!(health["status"], "ready", "{} not ready", name);
        println!("  {} ready (key_loaded={})", name, health["key_loaded"]);
    }

    // ── Step 3: Simulate deposit ──
    println!("\n[Step 3] Simulating BTC deposit...");

    // User's commitment (would normally be Poseidon(npk, token, amount))
    let commitment: [u8; 32] = sha256(b"mock_user_commitment_12345");
    println!("  Commitment: {}", hex::encode(commitment));

    // Compute tweaked deposit address (same as taproot.rs)
    let tweak = compute_tweak(&group_pubkey, &commitment);
    let scalar = secp256k1::Scalar::from_be_bytes(tweak)
        .map_err(|_| "invalid tweak scalar")?;
    let (tweaked_pubkey, _parity) = group_pubkey.add_tweak(&secp, &scalar)?;
    let deposit_address = Address::p2tr_tweaked(
        TweakedPublicKey::dangerous_assume_tweaked(tweaked_pubkey),
        Network::Testnet,
    );
    println!("  Deposit address: {}", deposit_address);

    // Mock UTXO: user sent 50,000 sats to this address
    let deposit_txid = Txid::from_byte_array(sha256(b"mock_deposit_txid"));
    let deposit_amount: u64 = 50_000;
    println!("  Mock UTXO: {}:{} ({} sats)", hex::encode(deposit_txid.to_byte_array()), 0, deposit_amount);

    // ── Step 4: Build sweep transaction ──
    println!("\n[Step 4] Building sweep transaction...");

    let pool_addr: Address<bitcoin::address::NetworkUnchecked> = POOL_RECEIVE_ADDR.parse()?;
    let pool_addr = pool_addr.assume_checked();

    // Fee estimation (same as sweeper.rs)
    let fee_rate: u64 = 2;
    let vsize: u64 = 10 + 58 + 43 + 45; // P2TR in + P2TR out + OP_RETURN
    let fee = vsize * fee_rate;
    let send_amount = deposit_amount - fee;

    // Build OP_RETURN with commitment
    let mut op_return_bytes = vec![0x6a, 0x20];
    op_return_bytes.extend_from_slice(&commitment);
    let op_return_script = ScriptBuf::from_bytes(op_return_bytes);

    let unsigned_tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint { txid: deposit_txid, vout: 0 },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: Witness::new(),
        }],
        output: vec![
            TxOut {
                value: Amount::from_sat(send_amount),
                script_pubkey: pool_addr.script_pubkey(),
            },
            TxOut {
                value: Amount::ZERO,
                script_pubkey: op_return_script,
            },
        ],
    };

    println!("  Fee: {} sats ({} vbytes × {} sat/vbyte)", fee, vsize, fee_rate);
    println!("  Send amount: {} sats → {}", send_amount, POOL_RECEIVE_ADDR);
    println!("  OP_RETURN: commitment embedded");

    // Build prevout (for sighash computation)
    let deposit_script = ScriptBuf::new_p2tr_tweaked(
        TweakedPublicKey::dangerous_assume_tweaked(tweaked_pubkey),
    );
    let prevout = TxOut {
        value: Amount::from_sat(deposit_amount),
        script_pubkey: deposit_script.clone(),
    };
    let prevouts = vec![prevout];

    // ── Step 5: Compute sighash ──
    println!("\n[Step 5] Computing BIP-341 sighash...");

    let mut sighash_cache = SighashCache::new(&unsigned_tx);
    let sighash = sighash_cache
        .taproot_key_spend_signature_hash(0, &Prevouts::All(&prevouts), TapSighashType::Default)?;
    let sighash_bytes = sighash.to_byte_array();
    let sighash_hex = hex::encode(sighash_bytes);
    println!("  Sighash: {}", sighash_hex);

    // Build SigningContext (what the backend sends to signers)
    let raw_tx_hex = serialize_hex(&unsigned_tx);
    let signing_context = SigningContext {
        raw_tx_hex: raw_tx_hex.clone(),
        prevouts: vec![PrevoutInfo {
            txid: hex::encode(deposit_txid.to_byte_array()),
            vout: 0,
            amount_sats: deposit_amount,
            script_pubkey_hex: hex::encode(deposit_script.as_bytes()),
        }],
        input_index: 0,
    };

    // ── Step 6: FROST signing protocol via HTTP ──
    println!("\n[Step 6] FROST signing protocol...");

    let session_id = uuid::Uuid::new_v4();
    let tweak_hex = hex::encode(tweak);

    // ── Round 1: Collect commitments ──
    println!("  Round 1: Collecting commitments from 2 signers...");
    let mut commitments: BTreeMap<u16, String> = BTreeMap::new();
    let mut identifier_map: BTreeMap<u16, String> = BTreeMap::new();

    let commitment_hex = hex::encode(commitment);

    for (name, url) in [("Signer 1", SIGNER1_URL), ("Signer 2", SIGNER2_URL)] {
        let request = Round1Request {
            session_id,
            sighash: sighash_hex.clone(),
            tweak: Some(tweak_hex.clone()),
            signing_context: Some(signing_context.clone()),
            merkle_root: Some(commitment_hex.clone()),
            solana_verification: None,
        };

        let response: Round1Response = client
            .post(format!("{}/round1", url))
            .json(&request)
            .send().await?
            .error_for_status()?
            .json().await?;

        println!("    {} (id={}) → commitment OK", name, response.signer_id);
        commitments.insert(response.signer_id, response.commitment);
        identifier_map.insert(response.signer_id, response.frost_identifier);
    }

    // ── Broadcast Verification ──
    println!("  Verify: Checking broadcast consistency...");
    let mut digests: Vec<String> = Vec::new();

    for (name, url) in [("Signer 1", SIGNER1_URL), ("Signer 2", SIGNER2_URL)] {
        let request = VerifyCommitmentsRequest {
            session_id,
            commitments: commitments.clone(),
            identifier_map: identifier_map.clone(),
        };

        let response: VerifyCommitmentsResponse = client
            .post(format!("{}/verify-commitments", url))
            .json(&request)
            .send().await?
            .error_for_status()?
            .json().await?;

        println!("    {} digest: {}...", name, &response.digest[..16]);
        digests.push(response.digest);
    }

    assert_eq!(digests[0], digests[1], "Commitment digests don't match!");
    println!("    Digests match!");

    // ── Round 2: Collect signature shares ──
    println!("  Round 2: Collecting signature shares...");
    let mut signature_shares: BTreeMap<u16, String> = BTreeMap::new();

    for (name, url) in [("Signer 1", SIGNER1_URL), ("Signer 2", SIGNER2_URL)] {
        let request = Round2Request {
            session_id,
            sighash: sighash_hex.clone(),
            tweak: Some(tweak_hex.clone()),
            commitments: commitments.clone(),
            identifier_map: identifier_map.clone(),
            merkle_root: Some(commitment_hex.clone()),
        };

        let response: Round2Response = client
            .post(format!("{}/round2", url))
            .json(&request)
            .send().await?
            .error_for_status()?
            .json().await?;

        println!("    {} → share OK", name);
        signature_shares.insert(response.signer_id, response.signature_share);
    }

    // ── Aggregate (with BIP-341 tweak using commitment as merkle_root) ──
    println!("  Aggregate: Combining signature shares with Taproot tweak...");
    let agg_request = AggregateRequest {
        commitments,
        identifier_map,
        signature_shares,
        sighash: sighash_hex.clone(),
        merkle_root: Some(hex::encode(commitment)),
    };

    let agg_http_response = client
        .post(format!("{}/aggregate", SIGNER1_URL))
        .json(&agg_request)
        .send().await?;

    if !agg_http_response.status().is_success() {
        let status = agg_http_response.status();
        let body = agg_http_response.text().await?;
        return Err(format!("Aggregate failed ({}): {}", status, body).into());
    }

    let agg_response: AggregateResponse = agg_http_response.json().await?;

    let sig_bytes = hex::decode(&agg_response.signature)?;
    assert_eq!(sig_bytes.len(), 64, "Signature should be 64 bytes");
    println!("  Signature: {}...{}", &agg_response.signature[..16], &agg_response.signature[112..]);

    // ── Step 7: Verify signature ──
    println!("\n[Step 7] Verifying Schnorr signature...");

    // The FROST library produces a signature for the TWEAKED key
    // We need to verify against the tweaked group pubkey
    let sig = secp256k1::schnorr::Signature::from_slice(&sig_bytes)?;
    let msg = Message::from_digest(sighash_bytes);

    // Compute the tweaked group pubkey (group_pubkey + tweak)
    let tweaked_group = group_pubkey.add_tweak(&secp, &scalar)?.0;
    println!("  Tweaked group pubkey: {}", hex::encode(tweaked_group.serialize()));

    secp.verify_schnorr(&sig, &msg, &tweaked_group)
        .map_err(|e| format!("Signature verification FAILED: {}", e))?;
    println!("  Schnorr signature VERIFIED on tweaked group pubkey!");

    // ── Step 8: Build final signed transaction ──
    println!("\n[Step 8] Building final signed transaction...");
    let mut signed_tx = unsigned_tx.clone();
    signed_tx.input[0].witness = Witness::from_slice(&[&sig_bytes]);

    let signed_tx_hex = serialize_hex(&signed_tx);
    let signed_tx_bytes = serialize(&signed_tx);
    println!("  Signed tx size: {} bytes ({} hex chars)", signed_tx_bytes.len(), signed_tx_hex.len());
    println!("  Signed tx: {}...{}", &signed_tx_hex[..40], &signed_tx_hex[signed_tx_hex.len()-20..]);

    // Verify commitment is extractable from the signed tx
    let extracted = extract_commitment(&signed_tx);
    assert_eq!(extracted, Some(commitment), "Commitment extraction mismatch!");
    println!("  OP_RETURN commitment extracted and verified!");

    // ── Step 9: Test policy rejection (wrong sighash) ──
    println!("\n[Step 9] Testing policy rejection (sighash mismatch)...");
    let bad_session = uuid::Uuid::new_v4();
    let bad_request = Round1Request {
        session_id: bad_session,
        sighash: "ff".repeat(32), // fake sighash
        tweak: Some(tweak_hex.clone()),
        signing_context: Some(signing_context.clone()),
        merkle_root: Some(commitment_hex.clone()),
        solana_verification: None,
    };

    let bad_response = client
        .post(format!("{}/round1", SIGNER1_URL))
        .json(&bad_request)
        .send().await?;

    assert_eq!(bad_response.status().as_u16(), 403, "Should be 403 Forbidden");
    let error_body: serde_json::Value = bad_response.json().await?;
    assert_eq!(error_body["code"], "POLICY_SIGHASH_MISMATCH");
    println!("  Sighash mismatch correctly rejected: {}", error_body["code"]);

    // ── Step 10: Test policy rejection (blind signing) ──
    println!("\n[Step 10] Testing policy rejection (blind signing)...");
    let blind_request = Round1Request {
        session_id: uuid::Uuid::new_v4(),
        sighash: sighash_hex.clone(),
        tweak: None,
        signing_context: None, // no context
        merkle_root: None,
        solana_verification: None,
    };

    let blind_response = client
        .post(format!("{}/round1", SIGNER1_URL))
        .json(&blind_request)
        .send().await?;

    assert_eq!(blind_response.status().as_u16(), 400);
    let blind_body: serde_json::Value = blind_response.json().await?;
    assert_eq!(blind_body["code"], "POLICY_CONTEXT_REQUIRED");
    println!("  Blind signing correctly rejected: {}", blind_body["code"]);

    Ok(())
}

/// Start a FROST signer process with policy enforcement
fn start_signer(
    frost_bin: &std::path::Path,
    id: u16,
    key_dir: &str,
    bind: &str,
    audit_file: &str,
) -> Result<Child, Box<dyn std::error::Error>> {
    let key_file = format!("{}/signer{}.key.enc", key_dir, id);

    let child = Command::new(frost_bin)
        .args([
            "run",
            "--id", &id.to_string(),
            "--password", KEY_PASSWORD,
            "--key-file", &key_file,
            "--bind", bind,
            "--require-context",
            "--pool-address", POOL_RECEIVE_ADDR,
            "--max-fee", "50000",
            "--max-amount", "1000000000",
            "--audit-log", audit_file,
            "--network", "testnet",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;

    println!("  Signer {} started (pid={}, bind={})", id, child.id(), bind);
    Ok(child)
}

/// Compute SHA256 hash
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

/// Extract 32-byte commitment from OP_RETURN output
fn extract_commitment(tx: &Transaction) -> Option<[u8; 32]> {
    for output in &tx.output {
        let script = output.script_pubkey.as_bytes();
        if script.len() == 34 && script[0] == 0x6a && script[1] == 0x20 {
            let mut commitment = [0u8; 32];
            commitment.copy_from_slice(&script[2..34]);
            return Some(commitment);
        }
    }
    None
}
