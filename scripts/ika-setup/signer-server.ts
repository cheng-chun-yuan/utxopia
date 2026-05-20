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
const PORT = Number(process.env.IKA_SIGNER_PORT || "3030");

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const state = await readJson(STATE_PATH);
const payer = await readKeypair(PAYER_KEYPAIR_PATH);
const connection = new Connection(SOLANA_RPC_URL, "confirmed");
const attestation = loadAttestation(state);
const dwalletPublicKey = dwalletPublicKeyFromAttestation(attestation);
const grpc = loadGrpcClient(state.ika.grpcEndpoint);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(200, {
        ok: true,
        dwallet: state.ika?.dwallet,
        xonly: state.ika?.dwalletXOnlyPubkey,
        rpc: SOLANA_RPC_URL,
      });
    }

    if (req.method !== "POST" || url.pathname !== "/sign") {
      return json(404, { error: "not found" });
    }

    try {
      const body = await req.json();
      const approvalSig = body.approvalSig || body.approval_signature;
      const messageHex = body.messageHex || body.message_hex;
      if (typeof approvalSig !== "string" || approvalSig.length === 0) {
        return json(400, { error: "approvalSig required" });
      }
      if (typeof messageHex !== "string" || !/^[0-9a-fA-F]+$/.test(messageHex)) {
        return json(400, { error: "messageHex must be hex" });
      }

      const approvalTx = await connection.getTransaction(approvalSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!approvalTx) {
        return json(404, { error: "approval tx not found", approvalSig });
      }

      const presignId = await requestPresign(grpc, payer, dwalletPublicKey, attestation);
      const signature = await requestSign(
        grpc,
        payer,
        dwalletPublicKey,
        attestation,
        hexToBytes(messageHex),
        presignId,
        approvalSig,
        BigInt(approvalTx.slot),
      );

      return json(200, {
        signatureHex: bytesToHex(signature),
        approvalSlot: approvalTx.slot,
        presignId: bytesToHex(presignId),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("sign failed", message);
      return json(500, { error: message });
    }
  },
});

console.log(
  JSON.stringify({
    service: "ika-signer",
    port: PORT,
    dwallet: state.ika?.dwallet,
    xonly: state.ika?.dwalletXOnlyPubkey,
  }),
);
