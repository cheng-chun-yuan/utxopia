#!/usr/bin/env bun
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { secp256k1, schnorr } from "../../sdk/node_modules/@noble/curves/secp256k1.js";
import { sha256 } from "../../sdk/node_modules/@noble/hashes/sha2.js";
import { keccak_256 } from "../../sdk/node_modules/@noble/hashes/sha3.js";
import { existsSync, readFileSync } from "node:fs";
import {
  SignedRequestData,
  TransactionResponseData,
  VersionedDWalletDataAttestation,
  buildUserSignature,
  grpcSubmitTransaction,
  loadGrpcClient,
  requestPresign,
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
const MESSAGE_HEX =
  process.env.IKA_SIGN_MESSAGE_HEX ??
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAYER_KEYPAIR_PATH =
  process.env.PAYER_KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`;
const SIG_SCHEME_TAPROOT_SHA256 = 3;

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

function messageApprovalPda(publicKey: Uint8Array, messageDigest: Uint8Array) {
  const schemeLe = Buffer.alloc(2);
  schemeLe.writeUInt16LE(SIG_SCHEME_TAPROOT_SHA256, 0);
  return PublicKey.findProgramAddressSync(
    [
      ...dwalletPdaSeeds(0, publicKey),
      Buffer.from("message_approval"),
      schemeLe,
      Buffer.from(messageDigest),
    ],
    IKA_PROGRAM_ID,
  );
}

async function sendMessageApproval(
  connection: Connection,
  payer: Keypair,
  dwallet: PublicKey,
  publicKey: Uint8Array,
  messageDigest: Uint8Array,
): Promise<{ messageApproval: PublicKey; signature: string; slot: bigint }> {
  const [messageApproval, bump] = messageApprovalPda(publicKey, messageDigest);
  const existing = await connection.getAccountInfo(messageApproval, "confirmed");
  if (existing) {
    const sigs = await connection.getSignaturesForAddress(messageApproval, { limit: 1 });
    const signature = sigs[0]?.signature;
    if (!signature) {
      throw new Error(`MessageApproval exists but no tx signature was found: ${messageApproval}`);
    }
    return {
      messageApproval,
      signature,
      slot: BigInt(sigs[0].slot),
    };
  }

  const [coordinator] = PublicKey.findProgramAddressSync(
    [Buffer.from("dwallet_coordinator")],
    IKA_PROGRAM_ID,
  );
  const data = Buffer.alloc(100);
  data[0] = 8;
  data[1] = bump;
  Buffer.from(messageDigest).copy(data, 2);
  Buffer.from(new Uint8Array(32)).copy(data, 34);
  Buffer.from(payer.publicKey.toBytes()).copy(data, 66);
  data.writeUInt16LE(SIG_SCHEME_TAPROOT_SHA256, 98);

  const ix = new TransactionInstruction({
    programId: IKA_PROGRAM_ID,
    keys: [
      { pubkey: coordinator, isSigner: false, isWritable: false },
      { pubkey: messageApproval, isSigner: false, isWritable: true },
      { pubkey: dwallet, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer);

  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(signature, "confirmed");
  const confirmed = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!confirmed) {
    throw new Error(`approval transaction not found after confirm: ${signature}`);
  }
  return { messageApproval, signature, slot: BigInt(confirmed.slot) };
}

if (!existsSync(PAYER_KEYPAIR_PATH)) {
  throw new Error(`PAYER_KEYPAIR_PATH not found: ${PAYER_KEYPAIR_PATH}`);
}
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(PAYER_KEYPAIR_PATH, "utf-8"))),
);
const importPriv = hexToBytes(IMPORT_PRIV);
const message = hexToBytes(MESSAGE_HEX);
if (importPriv.length !== 32) throw new Error("IMPORT_PRIV must be 32-byte hex");
if (message.length === 0) throw new Error("IKA_SIGN_MESSAGE_HEX must not be empty");

const expectedCompressed = secp256k1.getPublicKey(importPriv, true);
const session = crypto.getRandomValues(new Uint8Array(32));
const grpc = loadGrpcClient(GRPC_URL);

console.log("\n=== Ika imported-key sign/verify ===");
console.log(`RPC:                  ${RPC_URL}`);
console.log(`gRPC:                 ${GRPC_URL}`);
console.log(`payer:                ${payer.publicKey.toBase58()}`);
console.log(`input key pubkey:     ${bytesToHex(expectedCompressed)}`);
console.log(`message:              ${bytesToHex(message)}`);

const importRequest = SignedRequestData.serialize({
  session_identifier_preimage: Array.from(session),
  epoch: 1n,
  chain_id: { Solana: true },
  intended_chain_sender: Array.from(payer.publicKey.toBytes()),
  request: {
    ImportedKeyVerification: {
      dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
      curve: { Secp256k1: true },
      centralized_party_message: Array.from(importPriv),
      user_secret_key_share: {
        Public: { public_user_secret_key_share: Array.from(importPriv) },
      },
      user_public_output: Array.from(importPriv),
    },
  },
}).toBytes();
const importResponse = TransactionResponseData.parse(
  new Uint8Array(await grpcSubmitTransaction(grpc, buildUserSignature(payer), importRequest)),
);
if (!importResponse.Attestation) {
  throw new Error(`ImportedKeyVerification failed: ${JSON.stringify(importResponse)}`);
}

const attestation = importResponse.Attestation;
const attestationData = new Uint8Array(attestation.attestation_data);
const parsed = VersionedDWalletDataAttestation.parse(attestationData);
if (!parsed.V1) {
  throw new Error(`unexpected dWallet attestation: ${JSON.stringify(parsed)}`);
}
if (!parsed.V1.is_imported_key) {
  throw new Error("ImportedKeyVerification returned a non-imported dWallet");
}

const publicKey = Uint8Array.from(parsed.V1.public_key);
const xOnlyPublicKey = publicKey.subarray(1);
const [dwallet] = PublicKey.findProgramAddressSync(
  dwalletPdaSeeds(0, publicKey),
  IKA_PROGRAM_ID,
);

console.log(`returned pubkey:      ${bytesToHex(publicKey)}`);
console.log(`returned x-only:      ${bytesToHex(xOnlyPublicKey)}`);
console.log(`matches input key:    ${bytesToHex(publicKey) === bytesToHex(expectedCompressed)}`);
console.log(`dWallet PDA:          ${dwallet.toBase58()}`);

const connection = new Connection(RPC_URL, "confirmed");
const messageDigest = keccak_256(message);
const approval = await sendMessageApproval(
  connection,
  payer,
  dwallet,
  publicKey,
  messageDigest,
);
console.log(`approval digest:      ${bytesToHex(messageDigest)}`);
console.log(`MessageApproval PDA:  ${approval.messageApproval.toBase58()}`);
console.log(`approval tx:          ${approval.signature}`);

const presignId = await requestPresign(grpc, payer, publicKey, {
  attestationData,
  networkSignature: new Uint8Array(attestation.network_signature),
  networkPubkey: new Uint8Array(attestation.network_pubkey),
  epoch: BigInt(attestation.epoch),
});
const signRequest = SignedRequestData.serialize({
  session_identifier_preimage: Array.from(parsed.V1.session_identifier),
  epoch: 1n,
  chain_id: { Solana: true },
  intended_chain_sender: Array.from(payer.publicKey.toBytes()),
  request: {
    ImportedKeySign: {
      message: Array.from(message),
      message_metadata: [],
      presign_session_identifier: Array.from(presignId),
      message_centralized_signature: Array.from(new Uint8Array(64)),
      dwallet_attestation: {
        attestation_data: Array.from(attestationData),
        network_signature: Array.from(new Uint8Array(attestation.network_signature)),
        network_pubkey: Array.from(new Uint8Array(attestation.network_pubkey)),
        epoch: BigInt(attestation.epoch),
      },
      approval_proof: {
        Solana: {
          transaction_signature: Array.from(bs58.decode(approval.signature)),
          slot: approval.slot,
        },
      },
    },
  },
}).toBytes();
const signResponse = TransactionResponseData.parse(
  new Uint8Array(await grpcSubmitTransaction(grpc, buildUserSignature(payer), signRequest)),
);
if (!signResponse.Signature) {
  throw new Error(`ImportedKeySign failed: ${JSON.stringify(signResponse)}`);
}

const signature = Uint8Array.from(signResponse.Signature.signature);
const rawOk = schnorr.verify(signature, message, xOnlyPublicKey);
const sha256Ok = schnorr.verify(signature, sha256(message), xOnlyPublicKey);

console.log(`presign id:           ${bytesToHex(presignId)}`);
console.log(`signature:            ${bytesToHex(signature)}`);
console.log(`verify raw message:   ${rawOk}`);
console.log(`verify sha256(msg):   ${sha256Ok}`);

if (!sha256Ok) {
  throw new Error("ImportedKeySign signature did not verify against sha256(message)");
}
