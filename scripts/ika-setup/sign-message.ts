#!/usr/bin/env bun
import { Connection, Keypair } from "@solana/web3.js";
import {
  VersionedDWalletDataAttestation,
  loadGrpcClient,
  requestPresign,
  requestSign,
  type DWalletSetup,
} from "./lib/ika-setup-vendored.ts";

const STATE_PATH = process.env.STATE_PATH || "scripts/devnet-regtest-state.json";
const PAYER_KEYPAIR_PATH =
  process.env.PAYER_KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const APPROVAL_SIG = process.env.APPROVAL_SIG;
const MESSAGE_HEX = process.env.MESSAGE_HEX;

if (!APPROVAL_SIG) throw new Error("APPROVAL_SIG required");
if (!MESSAGE_HEX) throw new Error("MESSAGE_HEX required");

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await Bun.file(path).text());
}

async function readKeypair(path: string): Promise<Keypair> {
  const raw = JSON.parse(await Bun.file(path).text());
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadAttestation(state: any): DWalletSetup["attestation"] {
  const att = state.ika?.attestation;
  if (!att) throw new Error(`missing ika.attestation in ${STATE_PATH}`);
  return {
    attestationData: hexToBytes(att.attestationData),
    networkSignature: hexToBytes(att.networkSignature),
    networkPubkey: hexToBytes(att.networkPubkey),
    epoch: BigInt(att.epoch),
  };
}

function dwalletPublicKeyFromAttestation(attestation: DWalletSetup["attestation"]): Uint8Array {
  const parsed = VersionedDWalletDataAttestation.parse(attestation.attestationData);
  if (!parsed.V1) {
    throw new Error(`unsupported dWallet attestation payload: ${JSON.stringify(parsed)}`);
  }
  return Uint8Array.from(parsed.V1.public_key);
}

const state = await readJson(STATE_PATH);
const payer = await readKeypair(PAYER_KEYPAIR_PATH);
const connection = new Connection(SOLANA_RPC_URL, "confirmed");
const approvalTx = await connection.getTransaction(APPROVAL_SIG, {
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0,
});
if (!approvalTx) throw new Error(`approval tx not found: ${APPROVAL_SIG}`);

const attestation = loadAttestation(state);
const dwalletPublicKey = dwalletPublicKeyFromAttestation(attestation);
const grpc = loadGrpcClient(state.ika.grpcEndpoint);
const presignId = await requestPresign(grpc, payer, dwalletPublicKey, attestation);
const signature = await requestSign(
  grpc,
  payer,
  dwalletPublicKey,
  attestation,
  hexToBytes(MESSAGE_HEX),
  presignId,
  APPROVAL_SIG,
  BigInt(approvalTx.slot),
);

console.log(JSON.stringify({
  signatureHex: bytesToHex(signature),
  approvalSlot: approvalTx.slot,
  presignId: bytesToHex(presignId),
}));
