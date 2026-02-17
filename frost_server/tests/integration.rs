//! Integration tests for FROST server
//!
//! These tests require multiple signer instances to be running.

use frost_server::types::*;
use std::collections::BTreeMap;

/// Test configuration
const SIGNER_URLS: [&str; 3] = [
    "http://localhost:9001",
    "http://localhost:9002",
    "http://localhost:9003",
];

/// Skip test if signers are not running
fn signers_available() -> bool {
    let client = reqwest::blocking::Client::new();
    SIGNER_URLS.iter().all(|url| {
        client
            .get(format!("{}/health", url))
            .timeout(std::time::Duration::from_secs(1))
            .send()
            .is_ok()
    })
}

#[test]
#[ignore = "Requires running signer instances"]
fn test_health_endpoints() {
    if !signers_available() {
        eprintln!("Skipping test: signers not available");
        return;
    }

    let client = reqwest::blocking::Client::new();

    for (i, url) in SIGNER_URLS.iter().enumerate() {
        let response: HealthResponse = client
            .get(format!("{}/health", url))
            .send()
            .unwrap()
            .json()
            .unwrap();

        assert_eq!(response.signer_id, (i + 1) as u16);
        println!("Signer {}: status={}, key_loaded={}",
            response.signer_id, response.status, response.key_loaded);
    }
}

#[test]
#[ignore = "Requires running signer instances with loaded keys"]
fn test_full_signing_flow() {
    if !signers_available() {
        eprintln!("Skipping test: signers not available");
        return;
    }

    let client = reqwest::blocking::Client::new();
    let session_id = uuid::Uuid::new_v4();
    let sighash = [0x42u8; 32];
    let sighash_hex = hex::encode(sighash);

    // Round 1: Collect commitments from 2 signers (threshold)
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

        println!("Signer {} commitment: {}...",
            response.signer_id,
            &response.commitment[..20]);

        commitments.insert(response.signer_id, response.commitment);
        identifier_map.insert(response.signer_id, response.frost_identifier);
    }

    // Round 2: Collect signature shares
    let mut shares: Vec<(u16, String)> = Vec::new();

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

        println!("Signer {} share: {}...",
            response.signer_id,
            &response.signature_share[..20]);

        shares.push((response.signer_id, response.signature_share));
    }

    assert_eq!(shares.len(), 2);
    println!("Signing complete: {} signature shares collected", shares.len());
}

#[test]
#[ignore = "Requires fresh signer instances"]
fn test_dkg_ceremony() {
    if !signers_available() {
        eprintln!("Skipping test: signers not available");
        return;
    }

    let client = reqwest::blocking::Client::new();
    let ceremony_id = uuid::Uuid::new_v4();
    let threshold = 2u16;
    let total = 3u16;

    // DKG Round 1
    let mut round1_packages: BTreeMap<u16, String> = BTreeMap::new();

    for url in &SIGNER_URLS {
        let request = DkgRound1Request {
            ceremony_id,
            threshold,
            total_participants: total,
        };

        let response: DkgRound1Response = client
            .post(format!("{}/dkg/round1", url))
            .json(&request)
            .send()
            .expect("DKG round 1 failed")
            .json()
            .expect("DKG round 1 parse failed");

        round1_packages.insert(response.signer_id, response.package);
    }

    println!("DKG Round 1 complete: {} packages", round1_packages.len());

    // DKG Round 2
    let mut round2_packages: BTreeMap<u16, BTreeMap<u16, String>> = BTreeMap::new();

    for url in &SIGNER_URLS {
        let request = DkgRound2Request {
            ceremony_id,
            round1_packages: round1_packages.clone(),
        };

        let response: DkgRound2Response = client
            .post(format!("{}/dkg/round2", url))
            .json(&request)
            .send()
            .expect("DKG round 2 failed")
            .json()
            .expect("DKG round 2 parse failed");

        round2_packages.insert(response.signer_id, response.packages);
    }

    println!("DKG Round 2 complete: {} package sets", round2_packages.len());

    // DKG Finalize
    let mut group_pubkeys: Vec<String> = Vec::new();

    for (i, url) in SIGNER_URLS.iter().enumerate() {
        let signer_id = (i + 1) as u16;

        // Collect packages sent TO this signer
        let mut packages_for_signer: BTreeMap<u16, String> = BTreeMap::new();
        for (sender_id, packages) in &round2_packages {
            if let Some(pkg) = packages.get(&signer_id) {
                packages_for_signer.insert(*sender_id, pkg.clone());
            }
        }

        let request = DkgFinalizeRequest {
            ceremony_id,
            round1_packages: round1_packages.clone(),
            round2_packages: packages_for_signer,
        };

        let response: DkgFinalizeResponse = client
            .post(format!("{}/dkg/finalize", url))
            .json(&request)
            .send()
            .expect("DKG finalize failed")
            .json()
            .expect("DKG finalize parse failed");

        println!("Signer {} finalized: pubkey={}...",
            response.signer_id,
            &response.group_public_key[..16]);

        group_pubkeys.push(response.group_public_key);
    }

    // Verify all signers have the same group public key
    assert!(group_pubkeys.windows(2).all(|w| w[0] == w[1]));
    println!("DKG complete! Group public key: {}", group_pubkeys[0]);
}
