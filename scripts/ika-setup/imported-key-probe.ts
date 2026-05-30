#!/usr/bin/env bun
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { secp256k1 } from "../../sdk/node_modules/@noble/curves/secp256k1.js";
import { existsSync, readFileSync } from "node:fs";
import {
  SignedRequestData,
  TransactionResponseData,
  VersionedDWalletDataAttestation,
  buildUserSignature,
  grpcSubmitTransaction,
  loadGrpcClient,
} from "./lib/ika-setup-vendored.ts";

const IKA_PROGRAM_ID = new PublicKey(
  process.env.IKA_PROGRAM_ID ?? "87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY",
);
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const GRPC_URL =
  process.env.IKA_GRPC_URL ?? "pre-alpha-dev-1.ika.ika-network.net:443";
const IMPORT_PRIV =
  process.env.IMPORT_PRIV ??
  "04edfd60b32f55849a8a66f97f5d2033b359e67568e00e63831402cc931d0f78";
const PAYER_KEYPAIR_PATH =
  process.env.PAYER_KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`;

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function dwalletPdaSeeds(curve: number, publicKey: Uint8Array): Buffer[] {
  const payload = Buffer.alloc(2 + publicKey.length);
  payload.writeUInt16LE(curve, 0);
  Buffer.from(publicKey).copy(payload, 2);

  const seeds = [Buffer.from("dwallet")];
  for (let i = 0; i < payload.length; i += 32) {
    seeds.push(payload.subarray(i, Math.min(i + 32, payload.length)));
  }
  return seeds;
}

if (!existsSync(PAYER_KEYPAIR_PATH)) {
  throw new Error(`PAYER_KEYPAIR_PATH not found: ${PAYER_KEYPAIR_PATH}`);
}

const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(PAYER_KEYPAIR_PATH, "utf-8"))),
);
const importPriv = hexToBytes(IMPORT_PRIV);
if (importPriv.length !== 32) {
  throw new Error("IMPORT_PRIV must be 32-byte hex");
}

const expectedCompressed = secp256k1.getPublicKey(importPriv, true);
const session = crypto.getRandomValues(new Uint8Array(32));

const requestData = SignedRequestData.serialize({
  session_identifier_preimage: Array.from(session),
  epoch: 1n,
  chain_id: { Solana: true },
  intended_chain_sender: Array.from(payer.publicKey.toBytes()),
  request: {
    ImportedKeyVerification: {
      dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
      curve: { Secp256k1: true },
      // This is intentionally a probe. The Solana pre-alpha gRPC surface accepts
      // this request shape, but the real SDK normally generates these fields
      // from protocol public parameters and the imported key.
      centralized_party_message: Array.from(importPriv),
      user_secret_key_share: {
        Public: { public_user_secret_key_share: Array.from(importPriv) },
      },
      user_public_output: Array.from(importPriv),
    },
  },
}).toBytes();

console.log("\n=== Ika imported-key probe ===");
console.log(`RPC:                ${RPC_URL}`);
console.log(`gRPC:               ${GRPC_URL}`);
console.log(`Ika program:        ${IKA_PROGRAM_ID.toBase58()}`);
console.log(`payer:              ${payer.publicKey.toBase58()}`);
console.log(`session:            ${bytesToHex(session)}`);
console.log(`expected pubkey:    ${bytesToHex(expectedCompressed)}`);

const grpc = loadGrpcClient(GRPC_URL);
const responseBytes = await grpcSubmitTransaction(
  grpc,
  buildUserSignature(payer),
  requestData,
);
const response = TransactionResponseData.parse(new Uint8Array(responseBytes));

if (!response.Attestation) {
  console.log(JSON.stringify(response, null, 2));
  throw new Error("ImportedKeyVerification did not return an attestation");
}

const attestation = response.Attestation;
const payload = VersionedDWalletDataAttestation.parse(
  new Uint8Array(attestation.attestation_data),
);
if (!payload.V1) {
  throw new Error(`unexpected attestation payload: ${JSON.stringify(payload)}`);
}

const attestedPublicKey = Uint8Array.from(payload.V1.public_key);
const [dwalletPda] = PublicKey.findProgramAddressSync(
  dwalletPdaSeeds(0, attestedPublicKey),
  IKA_PROGRAM_ID,
);
const connection = new Connection(RPC_URL, "confirmed");
const dwalletAccount = await connection.getAccountInfo(dwalletPda, "confirmed");
const matchesImportKey =
  bytesToHex(attestedPublicKey) === bytesToHex(expectedCompressed);

console.log(`attested pubkey:    ${bytesToHex(attestedPublicKey)}`);
console.log(`matches import key: ${matchesImportKey}`);
console.log(`dWallet PDA:        ${dwalletPda.toBase58()}`);
console.log(
  `on-chain account:   ${dwalletAccount ? `${dwalletAccount.data.length} bytes` : "missing"}`,
);
console.log(
  `attestation data:   ${bytesToHex(new Uint8Array(attestation.attestation_data))}`,
);
console.log(
  `network signature:  ${bytesToHex(new Uint8Array(attestation.network_signature))}`,
);
console.log(`network pubkey:     ${bytesToHex(new Uint8Array(attestation.network_pubkey))}`);
console.log(`epoch:              ${attestation.epoch}`);

if (!matchesImportKey) {
  throw new Error(
    "Ika returned an attested public key that does not match IMPORT_PRIV; refusing to use it as pool custody.",
  );
}
