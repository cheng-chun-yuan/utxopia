#!/usr/bin/env node --experimental-strip-types --no-warnings
/**
 * Recon probe for ReEncryptShare against Ika devnet.
 *
 * Purpose: GO/NO-GO gate for the Encrypt integration SVES
 * (see docs/plans/2026-05-11-encrypt-integration-scope.md §3.5 step 1).
 *
 * Flow (entirely off-chain — no Solana tx, no SOL spent):
 *   1. Generate an ephemeral payer keypair (no funds required; just identity)
 *   2. gRPC DKG request with curve=Curve25519 + placeholder Encrypted share.
 *      The pre-alpha mock is known to accept all-zeros placeholders for the
 *      cryptographic fields and return a NetworkSignedAttestation. We use
 *      Curve25519 (32-byte pubkey) since the response is shorter to log.
 *   3. Take the attestation from step 2; submit a ReEncryptShare request
 *      asking the network to re-encrypt the (same placeholder) share to a
 *      freshly-generated "Bob" encryption key.
 *   4. Decode the response — three possible outcomes:
 *        - TransactionResponseData::Attestation(...) → SVES is feasible
 *        - TransactionResponseData::Error{message}  → log the message (likely
 *            "not implemented in mock" — fall back to §6)
 *        - Other / network error → log and decide
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings probe-reencrypt.ts
 */

import { Keypair } from "@solana/web3.js";
import {
  loadGrpcClient,
  grpcSubmitTransaction,
  buildUserSignature,
  SignedRequestData,
  TransactionResponseData,
  VersionedDWalletDataAttestation,
} from "../ika-setup/lib/ika-setup-vendored.ts";

const GRPC_URL =
  process.env.IKA_GRPC_URL ?? "pre-alpha-dev-1.ika.ika-network.net:443";

const ZERO32 = () => Array.from(new Uint8Array(32));
const ZERO64 = () => Array.from(new Uint8Array(64));

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function decodeResponse(bytes: Uint8Array): any {
  return TransactionResponseData.parse(bytes);
}

function logSection(name: string) {
  console.log(`\n── ${name} ──`);
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

const payer = Keypair.generate();
console.log("═══ ReEncryptShare recon probe ═══");
console.log(`gRPC endpoint:  ${GRPC_URL}`);
console.log(`Ephemeral payer: ${payer.publicKey.toBase58()}`);
console.log(`(no SOL spent — gRPC only)`);

const client = loadGrpcClient(GRPC_URL);

// ─── Step 1: DKG to produce an attestation we can feed into ReEncryptShare ──
logSection("Step 1: DKG (Curve25519, placeholder Encrypted user share)");

const dkgPayload = SignedRequestData.serialize({
  session_identifier_preimage: ZERO32(),
  epoch: 1n,
  chain_id: { Solana: true },
  intended_chain_sender: Array.from(payer.publicKey.toBytes()),
  request: {
    DKG: {
      dwallet_network_encryption_public_key: ZERO32(),
      curve: { Curve25519: true },
      centralized_public_key_share_and_proof: ZERO32(),
      user_secret_key_share: {
        Encrypted: {
          encrypted_centralized_secret_share_and_proof: ZERO32(),
          encryption_key: ZERO32(),
          signer_public_key: Array.from(payer.publicKey.toBytes()),
        },
      },
      user_public_output: ZERO32(),
      sign_during_dkg_request: null,
    },
  },
}).toBytes();

const dkgResponseBytes = await grpcSubmitTransaction(
  client,
  buildUserSignature(payer),
  dkgPayload,
);

const dkgResponse = decodeResponse(new Uint8Array(dkgResponseBytes));
if (!dkgResponse.Attestation) {
  console.log("✗ DKG did not return Attestation — sanity test FAILED");
  console.log(JSON.stringify(dkgResponse, null, 2));
  process.exit(1);
}

const dkgAttestation = dkgResponse.Attestation;
const dkgPayloadDecoded = VersionedDWalletDataAttestation.parse(
  new Uint8Array(dkgAttestation.attestation_data),
);
const dwalletPubkey = new Uint8Array(dkgPayloadDecoded.V1.public_key);
console.log(`✓ DKG attestation received`);
console.log(`  network_pubkey:   ${Buffer.from(dkgAttestation.network_pubkey).toString("hex").slice(0, 32)}…`);
console.log(`  dwallet pubkey:   ${Buffer.from(dwalletPubkey).toString("hex").slice(0, 32)}… (${dwalletPubkey.length} bytes)`);
console.log(`  epoch:            ${dkgAttestation.epoch}`);

// ─── Step 2: ReEncryptShare — the question we came to answer ─────────────
logSection("Step 2: ReEncryptShare (THE PROBE)");

// "Bob's encryption pubkey" — fresh placeholder; the network shouldn't care
// about its semantic validity for the purpose of "is this op implemented?"
const bobEncryptionKey = ZERO32();

const reEncryptPayload = SignedRequestData.serialize({
  session_identifier_preimage: ZERO32(),
  epoch: 1n,
  chain_id: { Solana: true },
  intended_chain_sender: Array.from(payer.publicKey.toBytes()),
  request: {
    ReEncryptShare: {
      dwallet_network_encryption_public_key: ZERO32(),
      dwallet_public_key: Array.from(dwalletPubkey),
      dwallet_attestation: {
        attestation_data: Array.from(dkgAttestation.attestation_data),
        network_signature: Array.from(dkgAttestation.network_signature),
        network_pubkey: Array.from(dkgAttestation.network_pubkey),
        epoch: dkgAttestation.epoch,
      },
      encrypted_centralized_secret_share_and_proof: ZERO32(),
      encryption_key: bobEncryptionKey,
    },
  },
}).toBytes();

console.log(`Submitting ReEncryptShare (${reEncryptPayload.length} bytes)...`);

let reEncryptResponseBytes: Uint8Array;
try {
  reEncryptResponseBytes = await grpcSubmitTransaction(
    client,
    buildUserSignature(payer),
    reEncryptPayload,
  );
} catch (e: any) {
  console.log("✗ gRPC call threw:");
  console.log(`  message: ${e.message ?? e}`);
  console.log(`  code:    ${e.code ?? "unknown"}`);
  console.log(`  details: ${e.details ?? "n/a"}`);
  console.log("\n── DECISION ──");
  console.log("NO-GO. ReEncryptShare is not callable on this endpoint.");
  console.log("Recommend: fall back to docs/plans/2026-05-11-encrypt-integration-scope.md §6");
  process.exit(2);
}

logSection("Response");

const reEncryptResponse = decodeResponse(
  new Uint8Array(reEncryptResponseBytes),
);

if (reEncryptResponse.Attestation) {
  const att = reEncryptResponse.Attestation;
  console.log(`✓ Attestation returned!`);
  console.log(`  attestation_data: ${att.attestation_data.length} bytes`);
  console.log(`  network_signature: ${att.network_signature.length} bytes`);
  console.log(`  network_pubkey:   ${Buffer.from(att.network_pubkey).toString("hex").slice(0, 32)}…`);
  console.log(`  epoch:            ${att.epoch}`);
  console.log("\n── DECISION ──");
  console.log("GO. ReEncryptShare returns a real attestation on pre-alpha.");
  console.log("Proceed with the full SVES (see scope plan §3.5 step 2+).");
  process.exit(0);
} else if (reEncryptResponse.Error) {
  console.log(`✗ Network returned Error:`);
  console.log(`  message: ${reEncryptResponse.Error.message}`);
  console.log("\n── DECISION ──");
  const msg = (reEncryptResponse.Error.message ?? "").toLowerCase();
  if (msg.includes("not implemented") || msg.includes("unimplemented") || msg.includes("not supported")) {
    console.log("NO-GO (graceful). ReEncryptShare wire format is accepted but the");
    console.log("mock signer doesn't implement it yet.");
    console.log("Recommend: fall back to scope plan §6 (4h AES-shaped variant).");
    process.exit(3);
  } else {
    console.log("INCONCLUSIVE. Error message doesn't match known not-implemented");
    console.log("patterns. Could be a validation issue with our placeholder bytes.");
    console.log("Recommend: read the error carefully, decide manually.");
    process.exit(4);
  }
} else if (reEncryptResponse.Signature) {
  console.log(`? Got Signature variant (unexpected for ReEncryptShare):`);
  console.log(JSON.stringify(reEncryptResponse, null, 2));
  process.exit(5);
} else {
  console.log("? Unknown response variant:");
  console.log(JSON.stringify(reEncryptResponse, null, 2));
  process.exit(6);
}
