//! Diagnostic test: compare SDK's taproot tweaking with FROST's tweaking

use bitcoin::secp256k1::{self, Message, Secp256k1, XOnlyPublicKey};
use frost_secp256k1_tr as frost;
use frost_secp256k1_tr::keys::Tweak;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Compute tagged hash (BIP-340): SHA256(SHA256(tag) || SHA256(tag) || msg)
fn tagged_hash(tag: &[u8], msg: &[u8]) -> [u8; 32] {
    let tag_hash = Sha256::digest(tag);
    let mut hasher = Sha256::new();
    hasher.update(&tag_hash);
    hasher.update(&tag_hash);
    hasher.update(msg);
    hasher.finalize().into()
}

/// SDK-style taproot output key derivation
fn sdk_derive_output_key(
    internal_key: &XOnlyPublicKey,
    commitment: &[u8; 32],
) -> XOnlyPublicKey {
    let secp = Secp256k1::new();
    let mut tweak_input = [0u8; 64];
    tweak_input[..32].copy_from_slice(&internal_key.serialize());
    tweak_input[32..].copy_from_slice(commitment);
    let tweak_bytes = tagged_hash(b"TapTweak", &tweak_input);
    let scalar = secp256k1::Scalar::from_be_bytes(tweak_bytes).expect("valid scalar");
    internal_key.add_tweak(&secp, &scalar).expect("valid tweak").0
}

#[test]
fn test_tweak_consistency_with_frost() {
    let mut rng = rand::thread_rng();
    let (shares, pubkey_package) = frost::keys::generate_with_dealer(
        3, 2,
        frost::keys::IdentifierList::Default,
        &mut rng,
    ).expect("DKG failed");

    // Get group verifying key as x-only
    let group_vk = pubkey_package.verifying_key();
    let group_vk_bytes = group_vk.serialize().expect("serialize vk");
    let group_pk = secp256k1::PublicKey::from_slice(&group_vk_bytes).expect("valid pubkey");
    let (group_xonly, _) = group_pk.x_only_public_key();
    println!("Group x-only key: {}", hex::encode(group_xonly.serialize()));

    let commitment: [u8; 32] = Sha256::digest(b"test_commitment_12345").into();
    println!("Commitment: {}", hex::encode(commitment));

    // === SDK-style output key ===
    let sdk_output_key = sdk_derive_output_key(&group_xonly, &commitment);
    println!("SDK  output key: {}", hex::encode(sdk_output_key.serialize()));

    // === FROST-style tweaked key ===
    let tweaked_pubkey_pkg = pubkey_package.clone().tweak(Some(&commitment));
    let tweaked_vk = tweaked_pubkey_pkg.verifying_key();
    let tweaked_vk_bytes = tweaked_vk.serialize().expect("serialize tweaked vk");
    let frost_pk = secp256k1::PublicKey::from_slice(&tweaked_vk_bytes).expect("valid frost pk");
    let (frost_output_key, _) = frost_pk.x_only_public_key();
    println!("FROST output key: {}", hex::encode(frost_output_key.serialize()));

    println!("Match: {}", sdk_output_key == frost_output_key);

    assert_eq!(
        sdk_output_key, frost_output_key,
        "SDK and FROST produce different output keys!"
    );

    // === Full sign + verify cycle ===
    let test_msg: [u8; 32] = Sha256::digest(b"test_sighash").into();
    // NOTE: Signers MUST use tweaked key packages. aggregate_with_tweak expects this.
    let id1 = frost::Identifier::try_from(1u16).unwrap();
    let id2 = frost::Identifier::try_from(2u16).unwrap();

    // Try A: signers use UNTWEAKED keys, aggregation applies tweak
    println!("\n--- Attempt A: signers untweaked, aggregate_with_tweak ---");
    let signer1_kp_raw = frost::keys::KeyPackage::try_from(shares[&id1].clone()).unwrap();
    let signer2_kp_raw = frost::keys::KeyPackage::try_from(shares[&id2].clone()).unwrap();
    {
        let (n1, c1) = frost::round1::commit(signer1_kp_raw.signing_share(), &mut rng);
        let (n2, c2) = frost::round1::commit(signer2_kp_raw.signing_share(), &mut rng);

        let mut cm = BTreeMap::new();
        cm.insert(*signer1_kp_raw.identifier(), c1);
        cm.insert(*signer2_kp_raw.identifier(), c2);

        let sp = frost::SigningPackage::new(cm, &test_msg);
        let s1 = frost::round2::sign(&sp, &n1, &signer1_kp_raw).unwrap();
        let s2 = frost::round2::sign(&sp, &n2, &signer2_kp_raw).unwrap();

        let mut ss = BTreeMap::new();
        ss.insert(*signer1_kp_raw.identifier(), s1);
        ss.insert(*signer2_kp_raw.identifier(), s2);

        // Use ORIGINAL (untweaked) pubkey package with aggregate_with_tweak
        match frost::aggregate_with_tweak(&sp, &ss, &pubkey_package, Some(&commitment)) {
            Ok(sig) => {
                let sb = sig.serialize().expect("ser");
                let schnorr = secp256k1::schnorr::Signature::from_slice(&sb).unwrap();
                let msg = Message::from_digest(test_msg);
                let secp = Secp256k1::new();
                match secp.verify_schnorr(&schnorr, &msg, &sdk_output_key) {
                    Ok(()) => println!("  ✅ Attempt A: PASSED — verify OK"),
                    Err(e) => println!("  ❌ Attempt A: sig ok but verify failed: {}", e),
                }
            }
            Err(e) => println!("  ❌ Attempt A: aggregation failed: {}", e),
        }
    }

    // Try B: signers use TWEAKED keys, aggregate_with_tweak
    println!("\n--- Attempt B: signers tweaked, aggregate_with_tweak ---");
    let signer1_kp = frost::keys::KeyPackage::try_from(shares[&id1].clone()).unwrap().tweak(Some(&commitment));
    let signer2_kp = frost::keys::KeyPackage::try_from(shares[&id2].clone()).unwrap().tweak(Some(&commitment));

    let (nonces1, comms1) = frost::round1::commit(signer1_kp.signing_share(), &mut rng);
    let (nonces2, comms2) = frost::round1::commit(signer2_kp.signing_share(), &mut rng);

    let mut comm_map = BTreeMap::new();
    comm_map.insert(*signer1_kp.identifier(), comms1);
    comm_map.insert(*signer2_kp.identifier(), comms2);

    let signing_package = frost::SigningPackage::new(comm_map, &test_msg);

    let sig1 = frost::round2::sign(&signing_package, &nonces1, &signer1_kp).unwrap();
    let sig2 = frost::round2::sign(&signing_package, &nonces2, &signer2_kp).unwrap();

    let mut sig_shares = BTreeMap::new();
    sig_shares.insert(*signer1_kp.identifier(), sig1);
    sig_shares.insert(*signer2_kp.identifier(), sig2);

    match frost::aggregate_with_tweak(
        &signing_package, &sig_shares, &tweaked_pubkey_pkg, Some(&commitment),
    ) {
        Ok(sig) => {
            let sb = sig.serialize().expect("ser");
            let schnorr = secp256k1::schnorr::Signature::from_slice(&sb).unwrap();
            let msg = Message::from_digest(test_msg);
            let secp = Secp256k1::new();
            match secp.verify_schnorr(&schnorr, &msg, &sdk_output_key) {
                Ok(()) => println!("  ✅ Attempt B: PASSED — verify OK"),
                Err(e) => println!("  ❌ Attempt B: sig ok but verify failed: {}", e),
            }
        }
        Err(e) => println!("  ❌ Attempt B: aggregation failed: {}", e),
    }

    // Try C: signers TWEAKED, regular aggregate (no tweak at aggregate step)
    println!("\n--- Attempt C: signers tweaked, regular aggregate ---");
    {
        let s1kp = frost::keys::KeyPackage::try_from(shares[&id1].clone()).unwrap().tweak(Some(&commitment));
        let s2kp = frost::keys::KeyPackage::try_from(shares[&id2].clone()).unwrap().tweak(Some(&commitment));

        let (n1, c1) = frost::round1::commit(s1kp.signing_share(), &mut rng);
        let (n2, c2) = frost::round1::commit(s2kp.signing_share(), &mut rng);

        let mut cm = BTreeMap::new();
        cm.insert(*s1kp.identifier(), c1);
        cm.insert(*s2kp.identifier(), c2);

        let sp = frost::SigningPackage::new(cm, &test_msg);
        let s1 = frost::round2::sign(&sp, &n1, &s1kp).unwrap();
        let s2 = frost::round2::sign(&sp, &n2, &s2kp).unwrap();

        let mut ss = BTreeMap::new();
        ss.insert(*s1kp.identifier(), s1);
        ss.insert(*s2kp.identifier(), s2);

        // Use TWEAKED pubkey package with regular aggregate (no additional tweak)
        match frost::aggregate(&sp, &ss, &tweaked_pubkey_pkg) {
            Ok(sig) => {
                let sb = sig.serialize().expect("ser");
                let schnorr = secp256k1::schnorr::Signature::from_slice(&sb).unwrap();
                let msg = Message::from_digest(test_msg);
                let secp = Secp256k1::new();
                match secp.verify_schnorr(&schnorr, &msg, &sdk_output_key) {
                    Ok(()) => println!("  ✅ Attempt C: PASSED — verify OK"),
                    Err(e) => println!("  ❌ Attempt C: sig ok but verify failed: {}", e),
                }
            }
            Err(e) => println!("  ❌ Attempt C: aggregation failed: {}", e),
        }
    }

    println!("\n✅ SDK and FROST produce identical output keys!");
}
