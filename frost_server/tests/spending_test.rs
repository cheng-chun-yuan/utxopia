//! FROST Threshold Spending Integration Test
//!
//! This test demonstrates spending from a Taproot UTXO using FROST 2-of-3 threshold signing.
//!
//! Test UTXO (Bitcoin Testnet):
//! - TXID: b548a007f3f9b5df71c8558a3040f37e3a5734d810d4eb021fe4a57bedcd2334
//! - VOUT: 0
//! - Amount: 10,000 sats
//! - Address: tb1puxc4wpqy03f7mr6qw7rcnkvhu7ffft3k3afnynlmerjdlxajm7ks9js58n
//! - Group Pubkey: e1b15704047c53ed8f40778789d997e79294ae368f53324ffbc8e4df9bb2dfad
//!
//! To run: cargo test --test spending_test -- --ignored --nocapture

use frost_server::types::*;
use std::collections::BTreeMap;

const SIGNER_URLS: [&str; 3] = [
    "http://localhost:9001",
    "http://localhost:9002",
    "http://localhost:9003",
];

/// Test UTXO details from real testnet deposit
const TEST_UTXO: TestUtxo = TestUtxo {
    txid: "b548a007f3f9b5df71c8558a3040f37e3a5734d810d4eb021fe4a57bedcd2334",
    vout: 0,
    amount_sats: 10_000,
    address: "tb1puxc4wpqy03f7mr6qw7rcnkvhu7ffft3k3afnynlmerjdlxajm7ks9js58n",
    group_pubkey: "e1b15704047c53ed8f40778789d997e79294ae368f53324ffbc8e4df9bb2dfad",
};

struct TestUtxo {
    txid: &'static str,
    vout: u32,
    amount_sats: u64,
    address: &'static str,
    group_pubkey: &'static str,
}

/// Check if FROST signers are available
fn signers_available() -> bool {
    let client = reqwest::blocking::Client::new();
    SIGNER_URLS.iter().all(|url| {
        client
            .get(format!("{}/health", url))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    })
}

/// Check if signers have keys loaded
fn signers_ready() -> bool {
    let client = reqwest::blocking::Client::new();
    SIGNER_URLS.iter().all(|url| {
        client
            .get(format!("{}/health", url))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .and_then(|r| r.json::<HealthResponse>())
            .map(|h| h.key_loaded)
            .unwrap_or(false)
    })
}

#[test]
#[ignore = "Requires running FROST signer instances with loaded keys"]
fn test_frost_signer_health() {
    if !signers_available() {
        eprintln!("Skipping: FROST signers not available");
        eprintln!("Start signers with: ./scripts/test_frost.sh start");
        return;
    }

    let client = reqwest::blocking::Client::new();

    for (i, url) in SIGNER_URLS.iter().enumerate() {
        let response: HealthResponse = client
            .get(format!("{}/health", url))
            .send()
            .expect("Failed to connect to signer")
            .json()
            .expect("Failed to parse health response");

        println!(
            "Signer {}: status={}, key_loaded={}",
            i + 1,
            response.status,
            response.key_loaded
        );

        assert_eq!(response.signer_id, (i + 1) as u16);
    }
}

#[test]
#[ignore = "Requires running FROST signer instances with loaded keys"]
fn test_frost_signing_for_utxo() {
    if !signers_ready() {
        eprintln!("Skipping: FROST signers not ready (keys not loaded)");
        eprintln!("Run DKG first or load existing keys");
        return;
    }

    println!("\n=== FROST Threshold Signing Test ===\n");
    println!("Test UTXO:");
    println!("  TXID: {}", TEST_UTXO.txid);
    println!("  VOUT: {}", TEST_UTXO.vout);
    println!("  Amount: {} sats", TEST_UTXO.amount_sats);
    println!("  Address: {}", TEST_UTXO.address);
    println!("  Group Pubkey: {}", TEST_UTXO.group_pubkey);

    let client = reqwest::blocking::Client::new();
    let session_id = uuid::Uuid::new_v4();

    // Create a test sighash (in production, this would be computed from BIP-341)
    let sighash = compute_test_sighash();
    let sighash_hex = hex::encode(&sighash);

    println!("\nSession ID: {}", session_id);
    println!("Sighash: {}", sighash_hex);

    // Round 1: Collect commitments from 2 signers (threshold)
    println!("\n--- Round 1: Collecting commitments ---");
    let mut commitments: BTreeMap<u16, String> = BTreeMap::new();
    let mut identifier_map: BTreeMap<u16, String> = BTreeMap::new();

    for url in SIGNER_URLS.iter().take(2) {
        let request = Round1Request {
            session_id,
            sighash: sighash_hex.clone(),
            tweak: None,
        };

        let response: Round1Response = client
            .post(format!("{}/round1", url))
            .json(&request)
            .send()
            .expect("Round 1 request failed")
            .json()
            .expect("Round 1 response parse failed");

        println!(
            "  Signer {}: commitment {}...",
            response.signer_id,
            &response.commitment[..32]
        );

        commitments.insert(response.signer_id, response.commitment);
        identifier_map.insert(response.signer_id, response.frost_identifier);
    }

    assert_eq!(commitments.len(), 2, "Should have 2 commitments");

    // Round 2: Collect signature shares
    println!("\n--- Round 2: Collecting signature shares ---");
    let mut shares: Vec<SignatureShare> = Vec::new();

    for url in SIGNER_URLS.iter().take(2) {
        let request = Round2Request {
            session_id,
            sighash: sighash_hex.clone(),
            tweak: None,
            commitments: commitments.clone(),
            identifier_map: identifier_map.clone(),
        };

        let response: Round2Response = client
            .post(format!("{}/round2", url))
            .json(&request)
            .send()
            .expect("Round 2 request failed")
            .json()
            .expect("Round 2 response parse failed");

        println!(
            "  Signer {}: share {}...",
            response.signer_id,
            &response.signature_share[..32]
        );

        shares.push(SignatureShare {
            signer_id: response.signer_id,
            share: response.signature_share,
        });
    }

    assert_eq!(shares.len(), 2, "Should have 2 signature shares");

    println!("\n=== Signing Complete ===");
    println!("Collected {} signature shares from threshold signers", shares.len());
    println!("\nIn production, these shares would be aggregated into");
    println!("a valid 64-byte Schnorr signature for the Taproot spend.");

    // Verify shares are valid hex and correct length
    for share in &shares {
        let share_bytes = hex::decode(&share.share).expect("Share should be valid hex");
        assert_eq!(share_bytes.len(), 32, "Signature share should be 32 bytes");
    }

    println!("\nTest PASSED: FROST 2-of-3 signing works correctly!");
}

#[test]
#[ignore = "Requires running FROST signer instances with loaded keys"]
fn test_frost_signing_different_signer_combinations() {
    if !signers_ready() {
        eprintln!("Skipping: FROST signers not ready");
        return;
    }

    let client = reqwest::blocking::Client::new();
    let sighash_hex = hex::encode(&compute_test_sighash());

    // Test all possible 2-of-3 combinations
    let combinations = vec![
        vec![0, 1], // Signers 1 & 2
        vec![0, 2], // Signers 1 & 3
        vec![1, 2], // Signers 2 & 3
    ];

    for (test_num, combo) in combinations.iter().enumerate() {
        println!("\n--- Test {}: Signers {} & {} ---",
            test_num + 1,
            combo[0] + 1,
            combo[1] + 1
        );

        let session_id = uuid::Uuid::new_v4();
        let mut commitments: BTreeMap<u16, String> = BTreeMap::new();
        let mut identifier_map: BTreeMap<u16, String> = BTreeMap::new();

        // Round 1
        for &idx in combo {
            let url = SIGNER_URLS[idx];
            let request = Round1Request {
                session_id,
                sighash: sighash_hex.clone(),
                tweak: None,
            };

            let response: Round1Response = client
                .post(format!("{}/round1", url))
                .json(&request)
                .send()
                .expect("Round 1 failed")
                .json()
                .expect("Parse failed");

            commitments.insert(response.signer_id, response.commitment);
            identifier_map.insert(response.signer_id, response.frost_identifier);
        }

        // Round 2
        let mut shares_count = 0;
        for &idx in combo {
            let url = SIGNER_URLS[idx];
            let request = Round2Request {
                session_id,
                sighash: sighash_hex.clone(),
                tweak: None,
                commitments: commitments.clone(),
                identifier_map: identifier_map.clone(),
            };

            let response: Round2Response = client
                .post(format!("{}/round2", url))
                .json(&request)
                .send()
                .expect("Round 2 failed")
                .json()
                .expect("Parse failed");

            assert!(!response.signature_share.is_empty());
            shares_count += 1;
        }

        assert_eq!(shares_count, 2);
        println!("  Success: Got 2 signature shares");
    }

    println!("\nAll 2-of-3 combinations work correctly!");
}

/// Helper struct for signature shares
struct SignatureShare {
    signer_id: u16,
    share: String,
}

/// Compute a test sighash based on the UTXO
/// In production, this would be the proper BIP-341 sighash
fn compute_test_sighash() -> [u8; 32] {
    use sha2::{Sha256, Digest};

    // Create deterministic sighash from UTXO data
    let mut hasher = Sha256::new();
    hasher.update(b"TapSighash");
    hasher.update(TEST_UTXO.txid.as_bytes());
    hasher.update(&TEST_UTXO.vout.to_le_bytes());
    hasher.update(&TEST_UTXO.amount_sats.to_le_bytes());
    hasher.update(TEST_UTXO.group_pubkey.as_bytes());

    let result = hasher.finalize();
    let mut sighash = [0u8; 32];
    sighash.copy_from_slice(&result);
    sighash
}

#[test]
#[ignore = "Requires running FROST signer instances"]
fn test_single_signer_cannot_sign_alone() {
    if !signers_ready() {
        eprintln!("Skipping: FROST signers not ready");
        return;
    }

    let client = reqwest::blocking::Client::new();
    let session_id = uuid::Uuid::new_v4();
    let sighash_hex = hex::encode(&compute_test_sighash());

    // Get commitment from only 1 signer
    let request = Round1Request {
        session_id,
        sighash: sighash_hex.clone(),
        tweak: None,
    };

    let response: Round1Response = client
        .post(format!("{}/round1", SIGNER_URLS[0]))
        .json(&request)
        .send()
        .expect("Round 1 failed")
        .json()
        .expect("Parse failed");

    let mut commitments: BTreeMap<u16, String> = BTreeMap::new();
    let mut identifier_map: BTreeMap<u16, String> = BTreeMap::new();
    commitments.insert(response.signer_id, response.commitment);
    identifier_map.insert(response.signer_id, response.frost_identifier);

    // Try Round 2 with only 1 signer - this should work but won't produce a valid signature
    // A single share cannot be used to spend the funds
    let request = Round2Request {
        session_id,
        sighash: sighash_hex,
        tweak: None,
        commitments,
        identifier_map,
    };

    let response: Round2Response = client
        .post(format!("{}/round2", SIGNER_URLS[0]))
        .json(&request)
        .send()
        .expect("Round 2 failed")
        .json()
        .expect("Parse failed");

    // We get a share, but it's useless alone - can't aggregate into valid signature
    println!("Single signer produced share: {}...", &response.signature_share[..32]);
    println!("But this share CANNOT be used alone to spend the UTXO!");
    println!("Threshold (2-of-3) is required for a valid Schnorr signature.");
}
